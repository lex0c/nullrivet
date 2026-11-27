import { isIPv4, isIPv6 } from 'node:net';

// The nftables ruleset of a sandbox's network namespace, generated from a scope of authorized
// destinations. The policy is drop in both directions, and every packet is matched, not only the
// first of a connection: an outgoing one against the authorized destinations with their ports, an
// incoming one against the same destinations and the connection it belongs to. No rule accepts a
// packet only because its connection is established, so a destination removed from the scope is
// refused at its connection's next packet. What is refused gets a TCP reset or an ICMP
// "administratively prohibited", so a tool reports it at once instead of waiting for a timeout.
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

// Checked again here, whatever built the scope: a value that is not one of these types never
// reaches the text.
const checkNetwork = (network: Network): string => {
  const parsed = parseNetwork(`${network.address}/${network.prefix}`);
  if (parsed === null || parsed.family !== network.family || parsed.address !== network.address) {
    throw new Error(`not a network in the form this module writes: ${network.address}`);
  }
  return `${parsed.address}/${parsed.prefix}`;
};

const portList = (ports: readonly number[]): string => {
  if (ports.length === 0 || !ports.every(isPort)) {
    throw new Error('ports must be integers from 1 to 65535, at least one');
  }
  return `{ ${[...new Set(ports)].sort((a, b) => a - b).join(', ')} }`;
};

const ip = (family: 4 | 6): string => (family === 4 ? 'ip' : 'ip6');

// Neighbor discovery on the link to the gateway: IPv6 does not work without it, and packets with
// a hop limit of 255 never left the link.
const NDP_OUT =
  'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } ip6 hoplimit 255 accept';
const NDP_IN =
  'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } ip6 hoplimit 255 accept';

export const TABLE = 'nullrivet';

export interface Ruleset {
  // One nft transaction that replaces whatever the namespace had: it applies whole or not at all.
  text: string;
  // The rules each chain holds once it is installed, to check against what the kernel lists.
  rules: { output: number; input: number; refuse: number };
}

const REFUSE = ['meta l4proto tcp reject with tcp reset', 'reject with icmpx admin-prohibited'];

export const rulesetFor = (scope: Scope): string => buildRuleset(scope).text;

export const buildRuleset = (scope: Scope): Ruleset => {
  const rate = scope.newConnectionsPerSecond;
  if (rate !== undefined && !(Number.isInteger(rate) && rate >= 1 && rate <= 1_000_000)) {
    throw new Error('the rate must be an integer number of new connections per second, at least 1');
  }
  const output: string[] = ['oif "lo" accept', NDP_OUT];
  const input: string[] = ['iif "lo" accept', NDP_IN];
  for (const network of scope.deny) {
    const target = checkNetwork(network);
    output.push(`${ip(network.family)} daddr ${target} goto refuse`);
    input.push(`${ip(network.family)} saddr ${target} drop`);
  }
  if (rate !== undefined) {
    output.push(
      `ct state new meta nfproto ipv4 update @new4 { ip daddr limit rate over ${rate}/second } goto refuse`,
      `ct state new meta nfproto ipv6 update @new6 { ip6 daddr limit rate over ${rate}/second } goto refuse`,
    );
  }
  for (const destination of scope.allow) {
    const family = destination.network.family;
    const target = checkNetwork(destination.network);
    const [echo, reply] =
      family === 4
        ? ['icmp type echo-request', 'icmp type echo-reply']
        : ['icmpv6 type echo-request', 'icmpv6 type echo-reply'];
    const errors =
      family === 4
        ? 'icmp type { destination-unreachable, time-exceeded, parameter-problem }'
        : 'icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem }';
    const ports = destination.ports === undefined ? '' : ` dport ${portList(destination.ports)}`;
    const sports = destination.ports === undefined ? '' : ` sport ${portList(destination.ports)}`;
    const daddr = `${ip(family)} daddr ${target}`;
    const saddr = `${ip(family)} saddr ${target}`;
    output.push(
      destination.ports === undefined
        ? `${daddr} meta l4proto tcp accept`
        : `${daddr} tcp${ports} accept`,
      destination.ports === undefined
        ? `${daddr} meta l4proto udp accept`
        : `${daddr} udp${ports} accept`,
      `${daddr} ${echo} accept`,
    );
    input.push(
      destination.ports === undefined
        ? `ct state established ${saddr} meta l4proto tcp accept`
        : `ct state established ${saddr} tcp${sports} accept`,
      destination.ports === undefined
        ? `ct state established ${saddr} meta l4proto udp accept`
        : `ct state established ${saddr} udp${sports} accept`,
      `ct state established ${saddr} ${reply} accept`,
      // Errors about authorized traffic, such as a closed UDP port or a hop limit reached.
      `ct state related ${saddr} ${errors} accept`,
    );
  }
  output.push('goto refuse');
  const lines = [
    'flush ruleset',
    `table inet ${TABLE} {`,
    '  set new4 { type ipv4_addr; size 65536; flags dynamic, timeout; timeout 10s; }',
    '  set new6 { type ipv6_addr; size 65536; flags dynamic, timeout; timeout 10s; }',
    '  chain output {',
    '    type filter hook output priority filter; policy drop;',
    ...output.map((rule) => `    ${rule}`),
    '  }',
    '  chain input {',
    '    type filter hook input priority filter; policy drop;',
    ...input.map((rule) => `    ${rule}`),
    '  }',
    '  chain refuse {',
    ...REFUSE.map((rule) => `    ${rule}`),
    '  }',
    '}',
    '',
  ];
  return {
    text: lines.join('\n'),
    rules: { output: output.length, input: input.length, refuse: REFUSE.length },
  };
};
