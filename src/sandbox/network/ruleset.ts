import { isIPv4, isIPv6 } from 'node:net';

// The nftables ruleset of a sandbox's network namespace, generated from a scope of authorized
// destinations. The policy is drop in both directions, and every packet is matched, not only the
// first of a connection: an outgoing one against the authorized destinations with their ports, an
// incoming one against the same destinations and the connection it belongs to. No rule accepts a
// packet only because its connection is established, so a destination removed from the scope is
// refused at its connection's next packet. What is refused gets a TCP reset or an ICMP
// "administratively prohibited", so a tool reports it at once instead of waiting for a timeout.
//
// The destinations are elements of interval sets, a network with a port for TCP and UDP, so the
// rules stay few whatever the scope's size. A transaction is limited by the host's socket buffer,
// which a user namespace cannot raise, so a scope is installed into a table of its own, one of two
// that take turns: its sets are filled in as many transactions as they need, while it has no chain
// on a hook and decides nothing; a last transaction, small whatever the scope's size, adds its
// chains and deletes the table in force. A scope takes effect whole, or not at all.
//
// Every address and port in the text comes from this module's own formatting of parsed values:
// nothing given as text reaches nft as it was written.

export interface Network {
  family: 4 | 6;
  // The network's first address, written in full: dotted decimal, or eight groups of hex digits.
  address: string;
  prefix: number;
}

export interface AllowedDestination {
  network: Network;
  // TCP and UDP ports; absent, every port. ICMP echo is allowed to every authorized network.
  ports?: readonly number[];
}

export interface Scope {
  allow: readonly AllowedDestination[];
  // Denied wins over allowed.
  deny: readonly Network[];
  // New connections each destination address may receive per second; absent, no limit.
  newConnectionsPerSecond?: number;
  // When anything may pass; absent, always. The kernel compares each packet's time with it, so
  // that the end holds whatever the process that installed it is doing.
  window?: { from: Date; until: Date };
}

// The scope that authorizes nothing: the namespace keeps its loopback only.
export const NOTHING: Scope = { allow: [], deny: [] };

const V4_BITS = 32n;
const V6_BITS = 128n;

const v4Value = (address: string): bigint =>
  address.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);

const v4Text = (value: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');

const v6Value = (address: string): bigint => {
  // An embedded IPv4 address ends the text in two groups.
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const v4 = v4Value(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
};

const v6Text = (value: bigint): string =>
  Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16),
  ).join(':');

// A network written as an address with an optional prefix length, or null when it is not one.
// Host bits past the prefix are cleared.
export const parseNetwork = (text: string): Network | null => {
  const match = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(text);
  if (match === null) return null;
  const address = match[1] as string;
  const family = isIPv4(address) ? 4 : isIPv6(address) && !address.includes('%') ? 6 : null;
  if (family === null) return null;
  const bits = family === 4 ? V4_BITS : V6_BITS;
  const prefix = match[2] === undefined ? Number(bits) : Number(match[2]);
  if (prefix > Number(bits)) return null;
  const value = family === 4 ? v4Value(address) : v6Value(address);
  const host = (1n << (bits - BigInt(prefix))) - 1n;
  const first = value & ~host & ((1n << bits) - 1n);
  return { family, address: family === 4 ? v4Text(first) : v6Text(first), prefix };
};

const isPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

const LAST_TIME = Date.UTC(2500, 0, 1);

// A time as nft reads it, in UTC, which the helpers' TZ makes it read: to the second, which nft
// keeps, rounded inward, so that the window it holds lies within the one given.
const nftTime = (date: Date, round: (seconds: number) => number): string => {
  const seconds = round(date.getTime() / 1000);
  return `"${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')}"`;
};

// The matches that hold outside `window`, before its start and from its end.
const windowRules = (window: Scope['window']): string[] => {
  if (window === undefined) return [];
  const { from, until } = window;
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime())) {
    throw new Error('the window must be of valid times');
  }
  // nft keeps a time in nanoseconds since 1970 in 64 bits, until 2554, and wraps one out of that
  // range in silence: a start before 1970 would read as one in 2484, and refuse everything.
  for (const date of [from, until]) {
    if (date.getTime() < 0 || date.getTime() >= LAST_TIME) {
      throw new Error('the window must lie between 1970 and 2500');
    }
  }
  const start = nftTime(from, Math.ceil);
  const end = nftTime(until, Math.floor);
  if (start >= end) throw new Error('the window must last at least a second');
  return [`meta time < ${start}`, `meta time >= ${end}`];
};

// Checked again here, whatever built the scope: a value that is not one of these types never
// reaches the text.
const checkNetwork = (network: Network): string => {
  const parsed = parseNetwork(`${network.address}/${network.prefix}`);
  if (parsed === null || parsed.family !== network.family || parsed.address !== network.address) {
    throw new Error(`not a network in the form this module writes: ${network.address}`);
  }
  return `${parsed.address}/${parsed.prefix}`;
};

const REFUSE_RULES = [
  'meta l4proto tcp reject with tcp reset',
  'reject with icmpx admin-prohibited',
];

// Neighbor discovery on the link to the gateway: IPv6 does not work without it, and packets with
// a hop limit of 255 never left the link.
const NDP_OUT =
  'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } ip6 hoplimit 255 accept';
const NDP_IN =
  'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } ip6 hoplimit 255 accept';

// The two tables a scope's ruleset takes turns in, and the one that closes the network.
export const SCOPE_TABLES = ['nullrivet_a', 'nullrivet_b'] as const;
export type ScopeTable = (typeof SCOPE_TABLES)[number];
export const CLOSED_TABLE = 'nullrivet_closed';
// The sets of the rate limit, whose elements the traffic adds.
export const DYNAMIC_SETS: readonly string[] = ['new4', 'new6'];

// The table that closes the network for good, apart from the scope's and before it: a packet must
// pass every base chain of its hook, so this one stops all but the loopback's, whatever the
// scope's table holds then or later. No installation of a scope touches it.
export const CLOSED_RULESET = [
  `table inet ${CLOSED_TABLE} {`,
  '  chain output {',
  '    type filter hook output priority -10; policy drop;',
  '    oif "lo" accept',
  ...REFUSE_RULES.map((rule) => `    ${rule}`),
  '  }',
  '  chain input {',
  '    type filter hook input priority -10; policy drop;',
  '    iif "lo" accept',
  '  }',
  '}',
  '',
].join('\n');

// Elements a transaction takes at most, well within the host's default socket buffer.
const ELEMENTS_PER_TRANSACTION = 1000;

interface Member {
  network: Network;
  port?: number;
}

const value = (network: Network): bigint =>
  network.family === 4 ? v4Value(network.address) : v6Value(network.address);

// The members without those inside another of the same family and port: an interval set refuses
// elements that overlap, and two networks either nest or do not meet. Sorted by family, port,
// first address and size, a member is inside another only if it is inside the last one kept.
const outermost = (members: readonly Member[]): Member[] => {
  const ranged = members.map((member) => {
    const bits = member.network.family === 4 ? V4_BITS : V6_BITS;
    const start = value(member.network);
    return { member, start, end: start + (1n << (bits - BigInt(member.network.prefix))) - 1n };
  });
  ranged.sort(
    (a, b) =>
      a.member.network.family - b.member.network.family ||
      (a.member.port ?? 0) - (b.member.port ?? 0) ||
      (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
      a.member.network.prefix - b.member.network.prefix,
  );
  const kept: Member[] = [];
  let last: (typeof ranged)[number] | null = null;
  for (const entry of ranged) {
    const sameGroup =
      last !== null &&
      last.member.network.family === entry.member.network.family &&
      last.member.port === entry.member.port;
    if (sameGroup && last !== null && entry.start <= last.end) continue;
    kept.push(entry.member);
    last = entry;
  }
  return kept;
};

interface SetSpec {
  name: string;
  type: string;
  members: Member[];
}

const element = (member: Member): string =>
  member.port === undefined
    ? checkNetwork(member.network)
    : `${checkNetwork(member.network)} . ${member.port}`;

// The transactions that install the scope into `table` and put it in force in place of
// `previous`, in order. The first makes `table` anew with its sets, and the next ones add to them:
// until the last, `table` has no chain on a hook. The last adds its chains and deletes `previous`.
export const rulesetFor = (
  scope: Scope,
  table: ScopeTable,
  previous: ScopeTable | null,
): string[] => {
  const times = windowRules(scope.window);
  const rate = scope.newConnectionsPerSecond;
  if (rate !== undefined && !(Number.isInteger(rate) && rate >= 1 && rate <= 1_000_000)) {
    throw new Error('the rate must be an integer number of new connections per second, at least 1');
  }
  const ported: Member[] = [];
  const any: Member[] = [];
  for (const destination of scope.allow) {
    checkNetwork(destination.network);
    if (destination.ports === undefined) {
      any.push({ network: destination.network });
      continue;
    }
    if (destination.ports.length === 0 || !destination.ports.every(isPort)) {
      throw new Error('ports must be integers from 1 to 65535, at least one');
    }
    for (const port of new Set(destination.ports))
      ported.push({ network: destination.network, port });
  }
  const family = (members: readonly Member[], wanted: 4 | 6) =>
    outermost(members.filter((member) => member.network.family === wanted));
  const echo = scope.allow.map((destination) => ({ network: destination.network }));
  const deny = scope.deny.map((network) => ({ network }));
  const sets: SetSpec[] = [];
  for (const wanted of [4, 6] as const) {
    const address = wanted === 4 ? 'ipv4_addr' : 'ipv6_addr';
    sets.push(
      { name: `deny${wanted}`, type: address, members: family(deny, wanted) },
      { name: `tcp${wanted}`, type: `${address} . inet_service`, members: family(ported, wanted) },
      { name: `udp${wanted}`, type: `${address} . inet_service`, members: family(ported, wanted) },
      { name: `any${wanted}`, type: address, members: family(any, wanted) },
      { name: `echo${wanted}`, type: address, members: family(echo, wanted) },
    );
  }
  // The elements, split into transactions of a bounded size.
  const chunks: { set: string; elements: string[] }[][] = [[]];
  let count = 0;
  for (const set of sets) {
    for (const member of set.members) {
      if (count === ELEMENTS_PER_TRANSACTION) {
        chunks.push([]);
        count = 0;
      }
      const chunk = chunks.at(-1) as { set: string; elements: string[] }[];
      const last = chunk.at(-1);
      if (last?.set === set.name) last.elements.push(element(member));
      else chunk.push({ set: set.name, elements: [element(member)] });
      count += 1;
    }
  }
  const first = new Map((chunks[0] ?? []).map((part) => [part.set, part.elements]));
  const output = [
    'oif "lo" accept',
    NDP_OUT,
    ...times.map((time) => `${time} goto refuse`),
    'ip daddr @deny4 goto refuse',
    'ip6 daddr @deny6 goto refuse',
    ...(rate === undefined
      ? []
      : [
          `ct state new meta nfproto ipv4 update @new4 { ip daddr limit rate over ${rate}/second } goto refuse`,
          `ct state new meta nfproto ipv6 update @new6 { ip6 daddr limit rate over ${rate}/second } goto refuse`,
        ]),
    'ip daddr . tcp dport @tcp4 accept',
    'ip daddr . udp dport @udp4 accept',
    'ip6 daddr . tcp dport @tcp6 accept',
    'ip6 daddr . udp dport @udp6 accept',
    'ip daddr @any4 meta l4proto { tcp, udp } accept',
    'ip6 daddr @any6 meta l4proto { tcp, udp } accept',
    'ip daddr @echo4 icmp type echo-request accept',
    'ip6 daddr @echo6 icmpv6 type echo-request accept',
    'goto refuse',
  ];
  const input = [
    'iif "lo" accept',
    NDP_IN,
    ...times.map((time) => `${time} drop`),
    'ip saddr @deny4 drop',
    'ip6 saddr @deny6 drop',
    'ct state established ip saddr . tcp sport @tcp4 accept',
    'ct state established ip saddr . udp sport @udp4 accept',
    'ct state established ip6 saddr . tcp sport @tcp6 accept',
    'ct state established ip6 saddr . udp sport @udp6 accept',
    'ct state established ip saddr @any4 meta l4proto { tcp, udp } accept',
    'ct state established ip6 saddr @any6 meta l4proto { tcp, udp } accept',
    'ct state established ip saddr @echo4 icmp type echo-reply accept',
    'ct state established ip6 saddr @echo6 icmpv6 type echo-reply accept',
    // Errors about authorized traffic, such as a closed UDP port or a hop limit reached.
    'ct state related ip saddr @echo4 icmp type { destination-unreachable, time-exceeded, parameter-problem } accept',
    'ct state related ip6 saddr @echo6 icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem } accept',
  ];
  const setLine = (set: SetSpec): string => {
    const elements = first.get(set.name);
    return `  set ${set.name} { type ${set.type}; flags interval;${elements === undefined ? '' : ` elements = { ${elements.join(', ')} };`} }`;
  };
  const staged = [
    // Made anew: created first so that deleting it never fails, whatever an earlier installation
    // that did not finish left of it.
    `add table inet ${table}`,
    `delete table inet ${table}`,
    `table inet ${table} {`,
    ...sets.map(setLine),
    '  set new4 { type ipv4_addr; size 65536; flags dynamic, timeout; timeout 10s; }',
    '  set new6 { type ipv6_addr; size 65536; flags dynamic, timeout; timeout 10s; }',
    '}',
    '',
  ].join('\n');
  const additions = chunks
    .slice(1)
    .map(
      (chunk) =>
        `${chunk.map((part) => `add element inet ${table} ${part.set} { ${part.elements.join(', ')} }`).join('\n')}\n`,
    );
  const activation = [
    `table inet ${table} {`,
    '  chain refuse {',
    ...REFUSE_RULES.map((rule) => `    ${rule}`),
    '  }',
    '  chain output {',
    '    type filter hook output priority filter; policy drop;',
    ...output.map((rule) => `    ${rule}`),
    '  }',
    '  chain input {',
    '    type filter hook input priority filter; policy drop;',
    ...input.map((rule) => `    ${rule}`),
    '  }',
    '}',
    // The table in force goes in the same transaction; the one that closes the network stays.
    ...(previous === null ? [] : [`add table inet ${previous}`, `delete table inet ${previous}`]),
    '',
  ].join('\n');
  return [staged, ...additions, activation];
};
