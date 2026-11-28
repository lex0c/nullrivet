import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { errorMessage } from '../errors.ts';
import {
  type AllowedDestination,
  type Network,
  parseNetwork,
  type Scope,
} from './network/ruleset.ts';

// The engagement file: what a security session may reach, and when. JSON, validated whole before
// anything starts: a field this module does not know, a malformed address or a window that ends
// before it starts stops the session, with the item that failed named. Host names are resolved by
// the host, once, when the session starts; the sandbox gets their addresses in its /etc/hosts and
// no resolver, so DNS cannot carry data out. An authorized address is not an authorized name: a
// name that resolves to a shared address authorizes everything served from it, and the session
// shows the addresses each name authorized.

export type Allowed =
  | { kind: 'network'; network: Network; ports?: readonly number[] }
  // A name reached through the proxy has no rule of its own: the proxy checks the name each
  // connection opens with.
  | { kind: 'host'; host: string; ports?: readonly number[]; via?: 'proxy' };

// A name the proxy reaches, with the addresses it resolved to when they were last checked.
export interface ProxiedName {
  host: string;
  ports?: readonly number[];
  addresses: string[];
}

export interface Engagement {
  name?: string;
  allow: Allowed[];
  // Denied wins over allowed.
  deny: Network[];
  window?: { from: Date; until: Date };
  newConnectionsPerSecond?: number;
  // Where the evidence log goes: as the file gives it, and absolute once read from a file, against
  // the file's directory.
  evidence?: { dir: string };
  // The file the engagement was read from, and the very bytes parsed, which the evidence log keeps.
  source?: { path: string; bytes: Buffer };
}

export interface ResolvedEngagement {
  engagement: Engagement;
  scope: Scope;
  // The addresses each name reached directly resolved to, which /etc/hosts gives the sandbox.
  names: { host: string; addresses: string[] }[];
  // Each entry reached through the proxy, which resolves its name again for each connection.
  proxied: ProxiedName[];
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_NAME_CHARS = 200;
const MAX_HOSTS = 1000;
// Each network or address once per port, or once for every port, and each denied network. Twenty
// thousand install in about a second; the ninety thousand that 4 MiB can hold pass the time a
// helper has.
const MAX_DESTINATIONS = 20_000;
const LOOKUPS_AT_ONCE = 16;
// How long one name may take, and all of them together: the session waits for them to start.
const RESOLUTION_LIMITS = { lookupMs: 10_000, totalMs: 30_000 };
const FAILURES_SHOWN = 10;

// Addresses that are not on the public internet. A name that resolves to one is a mistake, or an
// answer meant to reach the inside: a cloud's metadata service answers at a link-local address. It
// is authorized only when a cidr of the file holds it, allowed or denied.
const INTERNAL: readonly { network: Network; what: string }[] = (
  [
    ['0.0.0.0/8', 'unspecified'],
    ['10.0.0.0/8', 'private'],
    ['100.64.0.0/10', 'shared'],
    ['127.0.0.0/8', 'loopback'],
    ['169.254.0.0/16', 'link-local, where cloud metadata services answer'],
    ['172.16.0.0/12', 'private'],
    ['192.0.0.0/24', 'reserved'],
    ['192.168.0.0/16', 'private'],
    ['198.18.0.0/15', 'reserved'],
    ['224.0.0.0/4', 'multicast'],
    ['240.0.0.0/4', 'reserved'],
    ['::/128', 'unspecified'],
    ['::1/128', 'loopback'],
    ['::/96', 'IPv4-compatible'],
    ['::ffff:0:0/96', 'IPv4-mapped'],
    // An IPv4 address within an IPv6 one, which a translator on the way can reach: a private one
    // as well as a public one.
    ['64:ff9b::/96', 'NAT64'],
    ['64:ff9b:1::/48', 'local NAT64'],
    ['2002::/16', '6to4'],
    ['2001::/32', 'Teredo'],
    ['::ffff:0:0:0/96', 'IPv4-translated'],
    ['fc00::/7', 'private'],
    ['fec0::/10', 'site-local'],
    ['fe80::/10', 'link-local'],
    ['ff00::/8', 'multicast'],
  ] as const
).map(([text, what]) => ({ network: parseNetwork(text) as Network, what }));

// The addresses of this host's interfaces, the loopback's excepted.
export const hostAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) =>
      entry === undefined || entry.internal ? [] : [entry.address.replace(/%.*$/, '')],
    );

// The addresses among `addresses` the scope authorizes and does not deny.
export const authorizedAmong = (scope: Scope, addresses: readonly string[]): string[] =>
  addresses.filter((address) => {
    const network = parseNetwork(address);
    return (
      network !== null &&
      scope.allow.some((destination) => holds(destination.network, network)) &&
      !scope.deny.some((denied) => holds(denied, network))
    );
  });

// An address in full form as a number, from its dotted decimal or its eight groups of hex digits,
// worked out once for each: the proxy checks every address of a connection against a scope that
// can hold twenty thousand networks.
const values = new WeakMap<Network, bigint>();
const bits = (network: Network): bigint => {
  let value = values.get(network);
  if (value === undefined) {
    value =
      network.family === 4
        ? network.address.split('.').reduce((sum, part) => (sum << 8n) | BigInt(part), 0n)
        : network.address.split(':').reduce((sum, part) => (sum << 16n) | BigInt(`0x${part}`), 0n);
    values.set(network, value);
  }
  return value;
};

// A network's prefix bits, likewise.
const prefixes = new WeakMap<Network, bigint>();
const prefixOf = (network: Network): bigint => {
  let prefix = prefixes.get(network);
  if (prefix === undefined) {
    prefix = bits(network) >> BigInt((network.family === 4 ? 32 : 128) - network.prefix);
    prefixes.set(network, prefix);
  }
  return prefix;
};

// Whether `network` holds `address`.
const holds = (network: Network, address: Network): boolean =>
  network.family === address.family &&
  bits(address) >> BigInt((network.family === 4 ? 32 : 128) - network.prefix) === prefixOf(network);

// Whether two networks share an address.
export const overlaps = (a: Network, b: Network): boolean => holds(a, b) || holds(b, a);

// The range off the public internet that holds `network`, this host's addresses included.
const internalRange = (
  network: Network,
  ownAddresses: readonly string[],
): { network: Network; what: string } | undefined => {
  const own = ownAddresses.flatMap((text) => {
    const held = parseNetwork(text);
    return held === null ? [] : [{ network: held, what: 'an address of this host' }];
  });
  return [...own, ...INTERNAL].find((range) => holds(range.network, network));
};

// Why an address a name of the proxy resolves to may not be reached through it, or null. The
// proxy reaches only the public internet: a cidr that authorized an internal address would also
// open the direct way to it. An address the scope authorizes directly on the port is refused too,
// since the name would then be reached without the proxy as well. The host's addresses are read
// again for each connection, as a VPN can add one.
export const proxyRefusal = (
  direct: Scope,
  address: string,
  port: number,
  ownAddresses: readonly string[],
): { why: string; direct: boolean } | null => {
  const network = parseNetwork(address);
  if (network === null) return { why: 'not an address the proxy connects to', direct: false };
  const problem = unreachable(network, direct.deny, ownAddresses);
  if (problem !== null) return { why: problem, direct: false };
  const reached = direct.allow.some(
    (destination) =>
      holds(destination.network, network) &&
      (destination.ports === undefined || destination.ports.includes(port)),
  );
  return reached
    ? { why: `authorized directly on port ${port}, so reached without the proxy`, direct: true }
    : null;
};

// Why the proxy never reaches an address, whatever the port: off the public internet, or denied.
const unreachable = (
  network: Network,
  deny: readonly Network[],
  ownAddresses: readonly string[],
): string | null => {
  const internal = internalRange(network, ownAddresses);
  if (internal !== undefined) return `not on the public internet (${internal.what})`;
  return deny.some((denied) => holds(denied, network)) ? 'denied by the scope' : null;
};

// Each address of a name of the proxy that the direct scope authorizes on one of the name's ports,
// by a cidr or by a name reached directly that resolves to it: the sandbox would reach the name
// there without the proxy. The start and every refresh refuse a scope that has one. A denied address
// never reaches here: a name of the proxy that resolves to one is refused before.
const proxyConflicts = (direct: Scope, proxied: readonly ProxiedName[]): string[] => {
  const meet = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean =>
    a === undefined || b === undefined || a.some((port) => b.includes(port));
  const conflicts = new Set<string>();
  for (const { host, ports, addresses } of proxied) {
    for (const address of addresses) {
      const network = parseNetwork(address) as Network;
      const through = direct.allow.find(
        (destination) => holds(destination.network, network) && meet(destination.ports, ports),
      );
      if (through !== undefined) {
        conflicts.add(
          `${host} resolves to ${address}, which ${shown(through.network)}, ${portsText(through.ports)}, authorizes directly`,
        );
      }
    }
  }
  return [...conflicts];
};

const listed = (failures: string[]): string =>
  [
    ...failures.sort().slice(0, FAILURES_SHOWN),
    ...(failures.length > FAILURES_SHOWN ? [`and ${failures.length - FAILURES_SHOWN} more`] : []),
  ].join('; ');

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

class Invalid extends Error {}

const fail = (at: string, problem: string): never => {
  throw new Invalid(`${at}: ${problem}`);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyFields = (value: Record<string, unknown>, at: string, known: readonly string[]): void => {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) fail(at, `unknown field "${key}"`);
  }
};

const object = (value: unknown, at: string, known: readonly string[]): Record<string, unknown> => {
  if (!isObject(value)) return fail(at, 'must be an object');
  onlyFields(value, at, known);
  return value;
};

const array = (value: unknown, at: string): unknown[] =>
  Array.isArray(value) ? value : fail(at, 'must be an array');

const ports = (value: unknown, at: string): number[] | undefined => {
  if (value === undefined) return undefined;
  const list = array(value, at);
  if (list.length === 0) fail(at, 'must list at least one port, or be left out for every port');
  return list.map((port, index) =>
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : fail(`${at}[${index}]`, 'must be an integer from 1 to 65535'),
  );
};

// A network, written as an address with an optional prefix length, whose address is the network's
// first: one with host bits set past the prefix is a mistake, never widened in silence.
const network = (value: unknown, at: string): Network => {
  if (typeof value !== 'string') return fail(at, 'must be a string such as "203.0.113.0/28"');
  const parsed = parseNetwork(value);
  if (parsed === null) return fail(at, `"${value}" is not an IPv4 or IPv6 address or network`);
  const given = parseNetwork(value.split('/')[0] as string);
  if (given?.address !== parsed.address) {
    fail(at, `"${value}" has bits set past its prefix; the network is ${shown(parsed)}`);
  }
  return parsed;
};

const shown = (network: Network): string =>
  `${network.family === 4 ? network.address : compressed(network.address)}/${network.prefix}`;

// An IPv6 address in the form people write it, from the full form this module keeps.
const compressed = (address: string): string => {
  const groups = address.split(':').map((group) => group.replace(/^0+(?=.)/, ''));
  let best = { start: -1, length: 0 };
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === '0') j += 1;
    if (j - i > best.length && j - i > 1) best = { start: i, length: j - i };
    i = j;
  }
  if (best.start === -1) return groups.join(':');
  const head = groups.slice(0, best.start).join(':');
  const tail = groups.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// A host name in lower case and without a final dot, or why it is not one. A name whose last label
// is a number, as 10, 1.2.3 or 0x7f.1, is read by the resolver as an IPv4 address.
export const normalizedHost = (
  value: string,
): { name: string } | { problem: 'address' | 'name' } => {
  const name = value.toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  if (isIP(name) !== 0 || /^(?:\d+|0x[0-9a-f]*)$/.test(labels.at(-1) ?? '')) {
    return { problem: 'address' };
  }
  if (name.length === 0 || name.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return { problem: 'name' };
  }
  return { name };
};

// The host name an item of the file gives, normalized, or the item's failure.
const hostName = (value: unknown, at: string): string => {
  if (typeof value !== 'string') return fail(at, 'must be a string such as "app.example.com"');
  const normal = normalizedHost(value);
  if ('name' in normal) return normal.name;
  return normal.problem === 'address'
    ? fail(at, `"${value}" reads as an address: give it as a cidr`)
    : fail(at, `"${value}" is not a host name`);
};

// Fractions of a second to the millisecond, which is what a Date keeps: more would be dropped, and
// the window's start moved earlier.
const TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// A time with its offset, so it does not depend on the machine's time zone. Date takes a 30th of
// February, or 24:00, for a time of the day after: each field is checked against the calendar.
const time = (value: unknown, at: string): Date => {
  const match = typeof value === 'string' ? TIME.exec(value) : null;
  if (match === null) {
    return fail(at, 'must be a time with its offset, such as "2026-11-20T09:00:00-03:00"');
  }
  const [
    year = 0,
    month = 0,
    day = 0,
    hour = 0,
    minute = 0,
    second = 0,
    offsetHours = 0,
    offsetMinutes = 0,
  ] = match.slice(1).map((field) => Number(field ?? 0));
  const fields = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const date = new Date(value as string);
  if (
    fields.getUTCFullYear() !== year ||
    fields.getUTCMonth() !== month - 1 ||
    fields.getUTCDate() !== day ||
    fields.getUTCHours() !== hour ||
    fields.getUTCMinutes() !== minute ||
    fields.getUTCSeconds() !== second ||
    offsetHours > 23 ||
    offsetMinutes > 59 ||
    Number.isNaN(date.getTime())
  ) {
    return fail(at, `"${value}" is not a valid time`);
  }
  // What the kernel's clock comparison holds.
  if (date.getTime() < 0 || date.getTime() >= Date.UTC(2500, 0, 1)) {
    return fail(at, `"${value}" is not between 1970 and 2500`);
  }
  return date;
};

// The first key repeated in one object of `text`, which is valid JSON. JSON.parse keeps the last
// of two equal keys and drops the first without a word: a second "deny" would empty the first.
const repeatedKey = (text: string): string | null => {
  // The keys of each object open around the current position; null for an array.
  const open: (Set<string> | null)[] = [];
  let atKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = open.at(-1);
      if (atKey && keys) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
      }
      atKey = false;
      i = end;
    } else if (char === '{') {
      open.push(new Set());
      atKey = true;
    } else if (char === '[') {
      open.push(null);
    } else if (char === '}' || char === ']') {
      open.pop();
    } else if (char === ',') {
      atKey = open.at(-1) instanceof Set;
    }
  }
  return null;
};

export const parseEngagement = (text: string): Result<Engagement> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${errorMessage(error)}` };
  }
  const repeated = repeatedKey(text);
  if (repeated !== null) {
    return { ok: false, error: `the field "${repeated}" appears twice in one object` };
  }
  try {
    const root = object(value, 'the file', ['name', 'scope', 'window', 'rate', 'evidence']);
    const engagement: Engagement = { allow: [], deny: [] };
    if (root.name !== undefined) {
      if (
        typeof root.name !== 'string' ||
        root.name.trim() === '' ||
        root.name.length > MAX_NAME_CHARS ||
        /[\p{Cc}\p{Cf}]/u.test(root.name)
      ) {
        fail(
          'name',
          `must be a text of 1 to ${MAX_NAME_CHARS} characters, without control characters`,
        );
      }
      engagement.name = root.name as string;
    }
    if (root.evidence !== undefined) {
      const evidence = object(root.evidence, 'evidence', ['dir']);
      const dir = evidence.dir;
      if (typeof dir !== 'string' || dir === '' || dir.length > 4096 || dir.includes('\0')) {
        fail('evidence.dir', 'must be the path of a directory, as "./evidence"');
      }
      engagement.evidence = { dir: dir as string };
    }
    const scope = object(root.scope ?? fail('scope', 'is missing'), 'scope', ['allow', 'deny']);
    (scope.allow === undefined ? [] : array(scope.allow, 'scope.allow')).forEach((entry, index) => {
      const at = `scope.allow[${index}]`;
      const item = object(entry, at, ['cidr', 'host', 'ports', 'via']);
      const entryPorts = ports(item.ports, `${at}.ports`);
      if ((item.cidr === undefined) === (item.host === undefined)) {
        fail(at, 'must have either "cidr" or "host"');
      }
      if (item.via !== undefined && item.via !== 'proxy') fail(`${at}.via`, 'must be "proxy"');
      if (item.via !== undefined && item.cidr !== undefined) {
        fail(`${at}.via`, 'only a host is reached through the proxy: a cidr is reached directly');
      }
      engagement.allow.push(
        item.cidr !== undefined
          ? {
              kind: 'network',
              network: network(item.cidr, `${at}.cidr`),
              ...(entryPorts === undefined ? {} : { ports: entryPorts }),
            }
          : {
              kind: 'host',
              host: hostName(item.host, `${at}.host`),
              ...(entryPorts === undefined ? {} : { ports: entryPorts }),
              ...(item.via === 'proxy' ? { via: 'proxy' as const } : {}),
            },
      );
    });
    (scope.deny === undefined ? [] : array(scope.deny, 'scope.deny')).forEach((entry, index) => {
      const at = `scope.deny[${index}]`;
      const item = object(entry, at, ['cidr']);
      engagement.deny.push(network(item.cidr ?? fail(at, 'must have "cidr"'), `${at}.cidr`));
    });
    // A name reached both ways would have a direct way around the proxy.
    const ways = new Map<string, { proxied: boolean; at: string }>();
    engagement.allow.forEach((entry, index) => {
      if (entry.kind !== 'host') return;
      const proxied = entry.via === 'proxy';
      const seen = ways.get(entry.host);
      if (seen === undefined) ways.set(entry.host, { proxied, at: `scope.allow[${index}]` });
      else if (seen.proxied !== proxied) {
        fail(
          `scope.allow[${index}]`,
          `${entry.host} is reached ${seen.proxied ? 'through the proxy' : 'directly'} in ${seen.at}: a name is reached one way`,
        );
      }
    });
    if (engagement.allow.filter((entry) => entry.kind === 'host').length > MAX_HOSTS) {
      fail('scope.allow', `names more than ${MAX_HOSTS} hosts`);
    }
    if (root.window !== undefined) {
      const window = object(root.window, 'window', ['from', 'until']);
      const from = time(window.from ?? fail('window.from', 'is missing'), 'window.from');
      const until = time(window.until ?? fail('window.until', 'is missing'), 'window.until');
      if (until.getTime() <= from.getTime()) fail('window', 'ends before it starts');
      engagement.window = { from, until };
    }
    if (root.rate !== undefined) {
      const rate = object(root.rate, 'rate', ['newConnectionsPerSecond']);
      const value = rate.newConnectionsPerSecond;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
        fail('rate.newConnectionsPerSecond', 'must be an integer from 1 to 1000000');
      }
      engagement.newConnectionsPerSecond = value as number;
    }
    return { ok: true, value: engagement };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
};

// Reads and validates the engagement file at `path`.
export const readEngagement = async (path: string): Promise<Result<Engagement>> => {
  let bytes: Buffer;
  try {
    // Without blocking: a FIFO would hold the open until something writes to it.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile())
        return { ok: false, error: `the engagement file is not a regular file: ${path}` };
      const tooLarge = {
        ok: false,
        error: `the engagement file is larger than 4 MiB: ${path}`,
      } as const;
      if (info.size > MAX_FILE_BYTES) return tooLarge;
      // Read until the end or past the limit, whatever the size said: the file can grow
      // meanwhile, and a file of /proc says 0 for any size.
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.alloc(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > MAX_FILE_BYTES) return tooLarge;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ok: false, error: `cannot read the engagement file ${path}: ${errorMessage(error)}` };
  }
  const parsed = parseEngagement(bytes.toString('utf8'));
  if (!parsed.ok) return { ok: false, error: `the engagement file ${path}: ${parsed.error}` };
  const engagement = parsed.value;
  return {
    ok: true,
    value: {
      ...engagement,
      ...(engagement.evidence === undefined
        ? {}
        : { evidence: { dir: resolvePath(dirname(resolvePath(path)), engagement.evidence.dir) } }),
      source: { path: resolvePath(path), bytes },
    },
  };
};

export type LookupAll = (host: string) => Promise<string[]>;

// The host's resolver, every address of both families.
export const lookupAll: LookupAll = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// Resolves the engagement's names with the host's resolver and builds its scope: each address a
// name resolves to is authorized with that name's ports. A name that resolves to nothing, or in
// time, stops the session, as a typing mistake in a target would; so does one that resolves to an
// address off the public internet that no cidr of the file holds.
export const resolveEngagement = async (
  engagement: Engagement,
  resolve: LookupAll = lookupAll,
  limits: { lookupMs: number; totalMs: number } = RESOLUTION_LIMITS,
  ownAddresses: readonly string[] = hostAddresses(),
): Promise<Result<ResolvedEngagement>> => {
  const hosts = [
    ...new Set(engagement.allow.flatMap((entry) => (entry.kind === 'host' ? [entry.host] : []))),
  ];
  const addresses = new Map<string, string[]>();
  const failures: string[] = [];
  // Each wait ends by its own limit or by what is left of the whole, so that none outlasts the
  // whole. The lookup itself cannot be cancelled: one the resolver has not answered goes on in its
  // thread, and its answer is dropped.
  const deadline = Date.now() + limits.totalMs;
  const queue = [...hosts];
  const lookUp = async (): Promise<void> => {
    for (let host = queue.shift(); host !== undefined; host = queue.shift()) {
      const left = deadline - Date.now();
      const ms = Math.min(limits.lookupMs, left);
      const message =
        ms < limits.lookupMs
          ? `not resolved within the ${limits.totalMs / 1000} s all names have`
          : `the resolver did not answer within ${limits.lookupMs / 1000} s`;
      if (ms <= 0) {
        failures.push(`${host}: ${message}`);
        continue;
      }
      try {
        const found = await withTimeout(resolve(host), ms, message);
        // Addresses the ruleset takes: one with a zone, as fe80::1%eth0, is left out.
        const valid = [...new Set(found.filter((address) => parseNetwork(address) !== null))];
        if (valid.length === 0) failures.push(`${host}: no address`);
        else addresses.set(host, valid);
      } catch (error) {
        failures.push(`${host}: ${errorMessage(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, hosts.length) }, lookUp));
  if (failures.length > 0) {
    return { ok: false, error: `names of the engagement do not resolve: ${listed(failures)}` };
  }
  // An address of this host is reached through pasta as the host itself, its own services
  // included: it is held to the same rule as one off the public internet.
  // A cidr allows the name's ports when it has no ports, or all of them; a denied one makes the
  // address unreachable whatever the ports.
  const covers = (cidrPorts: readonly number[] | undefined, ports: readonly number[] | undefined) =>
    cidrPorts === undefined || ports?.every((port) => cidrPorts.includes(port)) === true;
  // Each entry of a name on its own, with its own ports: a name can appear more than once, and the
  // scope authorizes every one of its entries.
  const refused = new Set<string>();
  for (const entry of engagement.allow) {
    if (entry.kind !== 'host' || entry.via === 'proxy') continue;
    for (const address of addresses.get(entry.host) ?? []) {
      const network = parseNetwork(address) as Network;
      const internal = internalRange(network, ownAddresses);
      if (internal === undefined) continue;
      const named =
        engagement.deny.some((cidr) => holds(cidr, network)) ||
        engagement.allow.some(
          (cidr) =>
            cidr.kind === 'network' &&
            holds(cidr.network, network) &&
            covers(cidr.ports, entry.ports),
        );
      if (!named) refused.add(`${entry.host} resolves to ${address} (${internal.what})`);
    }
  }
  failures.push(...refused);
  if (failures.length > 0) {
    return {
      ok: false,
      error: `names of the engagement resolve to addresses that are not on the public internet, which a cidr of the file must hold, on the name's ports, to be authorized: ${listed(failures)}`,
    };
  }
  const proxied: ProxiedName[] = engagement.allow.flatMap((entry) =>
    entry.kind === 'host' && entry.via === 'proxy'
      ? [
          {
            host: entry.host,
            ...(entry.ports === undefined ? {} : { ports: entry.ports }),
            addresses: addresses.get(entry.host) ?? [],
          },
        ]
      : [],
  );
  const beyond = proxied.flatMap(({ host, addresses: found }) =>
    found.flatMap((address) => {
      const problem = unreachable(parseNetwork(address) as Network, engagement.deny, ownAddresses);
      return problem === null ? [] : [`${host} resolves to ${address}, ${problem}`];
    }),
  );
  if (beyond.length > 0) {
    return {
      ok: false,
      error: `names reached through the proxy must resolve to public addresses the scope does not deny: ${listed([...new Set(beyond)])}`,
    };
  }
  const allow: AllowedDestination[] = engagement.allow.flatMap((entry) => {
    const withPorts = (network: Network): AllowedDestination =>
      entry.ports === undefined ? { network } : { network, ports: entry.ports };
    if (entry.kind === 'network') return [withPorts(entry.network)];
    if (entry.via === 'proxy') return [];
    return (addresses.get(entry.host) ?? []).map((address) =>
      withPorts(parseNetwork(address) as Network),
    );
  });
  const destinations =
    allow.reduce((sum, entry) => sum + (entry.ports?.length ?? 1), 0) + engagement.deny.length;
  if (destinations > MAX_DESTINATIONS) {
    return {
      ok: false,
      error: `the scope holds ${destinations} destinations, more than ${MAX_DESTINATIONS}: each network or address counts once per port, and each denied network once`,
    };
  }
  const scope: Scope = {
    allow,
    deny: engagement.deny,
    ...(engagement.newConnectionsPerSecond === undefined
      ? {}
      : { newConnectionsPerSecond: engagement.newConnectionsPerSecond }),
    ...(engagement.window === undefined ? {} : { window: engagement.window }),
  };
  const conflicts = proxyConflicts(scope, proxied);
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `names reached through the proxy resolve to addresses the scope authorizes directly, where the sandbox would reach them without it: ${listed(conflicts)}`,
    };
  }
  const throughProxy = new Set(proxied.map(({ host }) => host));
  return {
    ok: true,
    value: {
      engagement,
      scope,
      names: hosts
        .filter((host) => !throughProxy.has(host))
        .map((host) => ({ host, addresses: addresses.get(host) ?? [] })),
      proxied,
    },
  };
};

// The sandbox's /etc/hosts: the loopback, and each name with the addresses it resolved to.
export const hostsFile = (resolved: ResolvedEngagement): string =>
  [
    '127.0.0.1 localhost',
    '::1 localhost',
    ...resolved.names.flatMap(({ host, addresses }) =>
      addresses.map((address) => `${address} ${host}`),
    ),
    '',
  ].join('\n');

export type WindowState = 'before' | 'open' | 'after';

// Where `now` falls in the engagement's window; open when it has none.
export const windowState = (engagement: Engagement, now: Date): WindowState => {
  if (engagement.window === undefined) return 'open';
  if (now.getTime() < engagement.window.from.getTime()) return 'before';
  return now.getTime() < engagement.window.until.getTime() ? 'open' : 'after';
};

const portsText = (entryPorts: readonly number[] | undefined): string =>
  entryPorts === undefined ? 'every port' : `ports ${entryPorts.join(', ')}`;

// The scope as lines of facts, for the operator at the start and for the model's system prompt.
// Every value is one this module validated or resolved: networks, host names, ports, times.
export const describeScope = (resolved: ResolvedEngagement): string[] => {
  const { engagement } = resolved;
  const addressesOf = new Map(resolved.names.map(({ host, addresses }) => [host, addresses]));
  const lines: string[] = [];
  const direct = engagement.allow.filter(
    (entry) => entry.kind === 'network' || entry.via !== 'proxy',
  );
  if (engagement.allow.length === 0) {
    lines.push('Nothing is authorized: the sandbox has no network.');
  }
  if (direct.length > 0) {
    lines.push('Authorized, over TCP and UDP, and ICMP echo:');
    for (const entry of direct) {
      lines.push(
        entry.kind === 'network'
          ? `- ${shown(entry.network)}, ${portsText(entry.ports)}`
          : `- ${entry.host}, ${portsText(entry.ports)}, at ${(addressesOf.get(entry.host) ?? []).join(', ')}`,
      );
    }
  }
  if (resolved.proxied.length > 0) {
    lines.push(
      'Authorized by name, through the proxy only, which HTTP_PROXY and HTTPS_PROXY name: HTTPS with the name in TLS, or plain HTTP with it in Host. There is no direct route to these names. The proxy resolves each name again for every connection, and checks the name a connection opens with, not each request inside TLS:',
    );
    for (const { host, ports, addresses } of resolved.proxied) {
      lines.push(`- ${host}, ${portsText(ports)}, last checked at ${addresses.join(', ')}`);
    }
  }
  if (engagement.deny.length > 0) {
    lines.push(`Denied, even where authorized: ${engagement.deny.map(shown).join(', ')}`);
  }
  if (engagement.newConnectionsPerSecond !== undefined) {
    lines.push(
      `At most ${engagement.newConnectionsPerSecond} new connections per second to each address${resolved.proxied.length > 0 ? ', directly and through the proxy each' : ''}.`,
    );
  }
  if (engagement.window !== undefined) {
    lines.push(
      `Only from ${engagement.window.from.toISOString()} until ${engagement.window.until.toISOString()}.`,
    );
  }
  return lines;
};
