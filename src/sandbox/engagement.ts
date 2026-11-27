import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
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
  | { kind: 'host'; host: string; ports?: readonly number[] };

export interface Engagement {
  name?: string;
  allow: Allowed[];
  // Denied wins over allowed.
  deny: Network[];
  window?: { from: Date; until: Date };
  newConnectionsPerSecond?: number;
}

export interface ResolvedEngagement {
  engagement: Engagement;
  scope: Scope;
  // The addresses each name resolved to, which /etc/hosts gives the sandbox.
  names: { host: string; addresses: string[] }[];
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
    ['::ffff:0:0/96', 'IPv4-mapped'],
    ['fc00::/7', 'private'],
    ['fec0::/10', 'site-local'],
    ['fe80::/10', 'link-local'],
    ['ff00::/8', 'multicast'],
  ] as const
).map(([text, what]) => ({ network: parseNetwork(text) as Network, what }));

// Whether `network` holds `address`.
const holds = (network: Network, address: Network): boolean =>
  network.family === address.family &&
  parseNetwork(`${address.address}/${network.prefix}`)?.address === network.address;

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

// A host name, in lower case, without a final dot.
const hostName = (value: unknown, at: string): string => {
  if (typeof value !== 'string') return fail(at, 'must be a string such as "app.example.com"');
  const name = value.toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  // A name whose last label is a number, as 10, 1.2.3 or 0x7f.1, is read by the resolver as an
  // IPv4 address.
  if (isIP(name) !== 0 || /^(?:\d+|0x[0-9a-f]*)$/.test(labels.at(-1) ?? '')) {
    fail(at, `"${value}" reads as an address: give it as a cidr`);
  }
  if (name.length === 0 || name.length > 253 || !labels.every((label) => LABEL.test(label))) {
    fail(at, `"${value}" is not a host name`);
  }
  return name;
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
      fail('evidence', 'the evidence log is not available yet; leave it out');
    }
    const scope = object(root.scope ?? fail('scope', 'is missing'), 'scope', ['allow', 'deny']);
    (scope.allow === undefined ? [] : array(scope.allow, 'scope.allow')).forEach((entry, index) => {
      const at = `scope.allow[${index}]`;
      const item = object(entry, at, ['cidr', 'host', 'ports']);
      const entryPorts = ports(item.ports, `${at}.ports`);
      if ((item.cidr === undefined) === (item.host === undefined)) {
        fail(at, 'must have either "cidr" or "host"');
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
            },
      );
    });
    (scope.deny === undefined ? [] : array(scope.deny, 'scope.deny')).forEach((entry, index) => {
      const at = `scope.deny[${index}]`;
      const item = object(entry, at, ['cidr']);
      engagement.deny.push(network(item.cidr ?? fail(at, 'must have "cidr"'), `${at}.cidr`));
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
  let text: string;
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
      text = Buffer.concat(chunks, length).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ok: false, error: `cannot read the engagement file ${path}: ${errorMessage(error)}` };
  }
  const parsed = parseEngagement(text);
  return parsed.ok ? parsed : { ok: false, error: `the engagement file ${path}: ${parsed.error}` };
};

export type LookupAll = (host: string) => Promise<string[]>;

// The host's resolver, every address of both families.
export const lookupAll: LookupAll = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
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
  const named = [
    ...engagement.allow.flatMap((entry) => (entry.kind === 'network' ? [entry.network] : [])),
    ...engagement.deny,
  ];
  for (const [host, found] of addresses) {
    for (const address of found) {
      const network = parseNetwork(address) as Network;
      const internal = INTERNAL.find((range) => holds(range.network, network));
      if (internal !== undefined && !named.some((cidr) => holds(cidr, network))) {
        failures.push(`${host} resolves to ${address} (${internal.what})`);
      }
    }
  }
  if (failures.length > 0) {
    return {
      ok: false,
      error: `names of the engagement resolve to addresses that are not on the public internet, which a cidr of the file must hold to be authorized: ${listed(failures)}`,
    };
  }
  const allow: AllowedDestination[] = engagement.allow.flatMap((entry) => {
    const withPorts = (network: Network): AllowedDestination =>
      entry.ports === undefined ? { network } : { network, ports: entry.ports };
    if (entry.kind === 'network') return [withPorts(entry.network)];
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
  return {
    ok: true,
    value: {
      engagement,
      scope: {
        allow,
        deny: engagement.deny,
        ...(engagement.newConnectionsPerSecond === undefined
          ? {}
          : { newConnectionsPerSecond: engagement.newConnectionsPerSecond }),
        ...(engagement.window === undefined ? {} : { window: engagement.window }),
      },
      names: hosts.map((host) => ({ host, addresses: addresses.get(host) ?? [] })),
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
  if (engagement.allow.length === 0) {
    lines.push('Nothing is authorized: the sandbox has no network.');
  } else {
    lines.push('Authorized, over TCP and UDP, and ICMP echo:');
    for (const entry of engagement.allow) {
      lines.push(
        entry.kind === 'network'
          ? `- ${shown(entry.network)}, ${portsText(entry.ports)}`
          : `- ${entry.host}, ${portsText(entry.ports)}, at ${(addressesOf.get(entry.host) ?? []).join(', ')}`,
      );
    }
  }
  if (engagement.deny.length > 0) {
    lines.push(`Denied, even where authorized: ${engagement.deny.map(shown).join(', ')}`);
  }
  if (engagement.newConnectionsPerSecond !== undefined) {
    lines.push(
      `At most ${engagement.newConnectionsPerSecond} new connections per second to each address.`,
    );
  }
  if (engagement.window !== undefined) {
    lines.push(
      `Only from ${engagement.window.from.toISOString()} until ${engagement.window.until.toISOString()}.`,
    );
  }
  return lines;
};
