import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeScope,
  type Engagement,
  hostsFile,
  parseEngagement,
  readEngagement,
  resolveEngagement,
  windowState,
} from '../../src/sandbox/engagement.ts';
import { rulesetFor } from '../../src/sandbox/network/ruleset.ts';

// The example of the documentation.
const EXAMPLE = {
  name: 'ACME external test',
  scope: {
    allow: [
      { cidr: '203.0.113.0/28', ports: [80, 443] },
      { host: 'App.ACME.example.', ports: [443] },
    ],
    deny: [{ cidr: '203.0.113.5/32' }],
  },
  window: { from: '2026-11-20T09:00:00-03:00', until: '2026-11-20T18:00:00-03:00' },
  rate: { newConnectionsPerSecond: 20 },
};

const parsed = (value: unknown): Engagement => {
  const result = parseEngagement(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const error = (value: unknown): string => {
  const result = parseEngagement(typeof value === 'string' ? value : JSON.stringify(value));
  return result.ok ? 'accepted' : result.error;
};

const withAllow = (entry: unknown) => ({ scope: { allow: [{ cidr: '198.51.100.0/24' }, entry] } });

describe('the engagement file', () => {
  test('reads the scope, the window and the rate, with names in lower case', () => {
    const engagement = parsed(EXAMPLE);
    expect(engagement.name).toBe('ACME external test');
    expect(engagement.allow).toEqual([
      {
        kind: 'network',
        network: { family: 4, address: '203.0.113.0', prefix: 28 },
        ports: [80, 443],
      },
      { kind: 'host', host: 'app.acme.example', ports: [443] },
    ]);
    expect(engagement.deny).toEqual([{ family: 4, address: '203.0.113.5', prefix: 32 }]);
    expect(engagement.window?.from.toISOString()).toBe('2026-11-20T12:00:00.000Z');
    expect(engagement.newConnectionsPerSecond).toBe(20);
    // A scope without anything allowed leaves the sandbox without network.
    expect(parsed({ scope: {} }).allow).toEqual([]);
  });

  test('refuses what it does not know, naming the item', () => {
    expect(error({ ...EXAMPLE, extra: 1 })).toBe('the file: unknown field "extra"');
    expect(error({ scope: { allow: [], other: [] } })).toBe('scope: unknown field "other"');
    expect(error(withAllow({ cidr: '10.0.0.0/8', protocol: 'tcp' }))).toBe(
      'scope.allow[1]: unknown field "protocol"',
    );
    expect(error({ scope: { deny: [{ host: 'a.example' }] } })).toBe(
      'scope.deny[0]: unknown field "host"',
    );
    expect(error({ name: 'x' })).toBe('scope: is missing');
    expect(error({ scope: { allow: [{ cidr: '10.0.0.0/8' }], deny: null } })).toBe(
      'scope.deny: must be an array',
    );
    expect(error({ scope: { allow: null } })).toBe('scope.allow: must be an array');
    expect(error('{"scope":')).toStartWith('not JSON');
    expect(error([])).toBe('the file: must be an object');
  });

  test('refuses malformed addresses, and a network whose address has bits past its prefix', () => {
    expect(error(withAllow({ cidr: '203.0.113.0/33' }))).toBe(
      'scope.allow[1].cidr: "203.0.113.0/33" is not an IPv4 or IPv6 address or network',
    );
    expect(error(withAllow({ cidr: '203.0.113.7/28' }))).toBe(
      'scope.allow[1].cidr: "203.0.113.7/28" has bits set past its prefix; the network is 203.0.113.0/28',
    );
    expect(error(withAllow({ cidr: '2001:db8::1/64' }))).toBe(
      'scope.allow[1].cidr: "2001:db8::1/64" has bits set past its prefix; the network is 2001:db8::/64',
    );
    expect(error(withAllow({ cidr: 24 }))).toContain('must be a string');
    expect(error(withAllow({ cidr: '10.0.0.0/8', host: 'a.example' }))).toBe(
      'scope.allow[1]: must have either "cidr" or "host"',
    );
    expect(error(withAllow({ ports: [80] }))).toBe(
      'scope.allow[1]: must have either "cidr" or "host"',
    );
  });

  test('refuses a key repeated in one object, which JSON.parse would keep the last of', () => {
    expect(
      error(
        '{"scope":{"allow":[{"cidr":"10.0.0.0/8"}],"deny":[{"cidr":"10.1.0.0/16"}],"deny":[]}}',
      ),
    ).toBe('the field "deny" appears twice in one object');
    expect(error('{"scope":{"deny":[{"cidr":"10.1.0.0/16"}],"d\\u0065ny":[]}}')).toBe(
      'the field "deny" appears twice in one object',
    );
    expect(error('{"scope":{"allow":[{"cidr":"10.0.0.0/8","cidr":"0.0.0.0/0"}]}}')).toBe(
      'the field "cidr" appears twice in one object',
    );
    // The same key in different objects, and keys within strings, are not repeated keys.
    expect(error(EXAMPLE)).toBe('accepted');
    expect(error('{"name":"a \\" { , \\"scope\\": [","scope":{}}')).toBe('accepted');
  });

  test('refuses host names that are not ones, and addresses given as names', () => {
    for (const host of [
      'app example',
      '-app.example',
      'a..example',
      `${'a'.repeat(64)}.example`,
      '',
    ]) {
      expect(error(withAllow({ host }))).toBe(`scope.allow[1].host: "${host}" is not a host name`);
    }
    // The resolver reads a name whose last label is a number as an IPv4 address.
    for (const host of [
      '203.0.113.1',
      '2001:db8::1',
      '10',
      '1.2.3',
      '3232235777',
      '0x7f.1',
      'a.0X1',
    ]) {
      expect(error(withAllow({ host }))).toBe(
        `scope.allow[1].host: "${host}" reads as an address: give it as a cidr`,
      );
    }
    expect(error(withAllow({ host: '1password.example' }))).toBe('accepted');
  });

  test('refuses ports out of range, of another type, or an empty list', () => {
    expect(error(withAllow({ cidr: '10.0.0.0/8', ports: [80, 0] }))).toBe(
      'scope.allow[1].ports[1]: must be an integer from 1 to 65535',
    );
    for (const port of [65536, 1.5, '80']) {
      expect(error(withAllow({ cidr: '10.0.0.0/8', ports: [port] }))).toBe(
        'scope.allow[1].ports[0]: must be an integer from 1 to 65535',
      );
    }
    expect(error(withAllow({ cidr: '10.0.0.0/8', ports: [] }))).toContain(
      'must list at least one port',
    );
  });

  test('refuses a window without offsets or that ends before it starts, and a bad rate', () => {
    expect(
      error({ ...EXAMPLE, window: { from: '2026-11-20T09:00:00', until: '2026-11-20T18:00:00Z' } }),
    ).toContain('window.from: must be a time with its offset');
    expect(
      error({
        ...EXAMPLE,
        window: { from: '2026-11-20T18:00:00Z', until: '2026-11-20T09:00:00Z' },
      }),
    ).toBe('window: ends before it starts');
    expect(error({ ...EXAMPLE, window: { from: '2026-11-20T09:00:00Z' } })).toBe(
      'window.until: is missing',
    );
    // Date would move these to the day after; each field is checked against the calendar.
    for (const from of [
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-11-31T10:00:00Z',
      '2026-11-20T24:00:00Z',
      '2026-11-20T23:59:60Z',
      '2026-11-20T09:00:00+24:00',
    ]) {
      expect(error({ ...EXAMPLE, window: { from, until: '2027-01-01T00:00:00Z' } })).toBe(
        `window.from: "${from}" is not a valid time`,
      );
    }
    expect(
      parsed({
        ...EXAMPLE,
        window: { from: '2028-02-29T23:59:59.5+14:00', until: '2029-01-01T00:00Z' },
      }).window?.from.toISOString(),
    ).toBe('2028-02-29T09:59:59.500Z');
    // What the kernel's clock comparison holds: nft wraps a time out of that range in silence.
    for (const from of ['1969-12-31T23:59:59Z', '2500-01-01T00:00:00Z']) {
      expect(error({ ...EXAMPLE, window: { from, until: '2500-06-01T00:00:00Z' } })).toBe(
        `window.from: "${from}" is not between 1970 and 2500`,
      );
    }
    // A Date keeps milliseconds: a finer fraction would be dropped, and the start moved earlier.
    expect(
      error({
        ...EXAMPLE,
        window: { from: '2026-11-20T09:00:00.0001Z', until: '2027-01-01T00:00:00Z' },
      }),
    ).toContain('window.from: must be a time with its offset');
    for (const rate of [0, 2.5, '20', 2_000_000]) {
      expect(error({ ...EXAMPLE, rate: { newConnectionsPerSecond: rate } })).toBe(
        'rate.newConnectionsPerSecond: must be an integer from 1 to 1000000',
      );
    }
  });

  test('refuses a name with control characters, which the terminal would interpret', () => {
    for (const name of ['ACME\u202etset', 'ACME\u001b[2J', 'ACME\nnext']) {
      expect(error({ ...EXAMPLE, name })).toBe(
        'name: must be a text of 1 to 200 characters, without control characters',
      );
    }
  });

  test('refuses the evidence log, which is not available yet, rather than ignore it', () => {
    expect(error({ ...EXAMPLE, evidence: { dir: './evidence' } })).toBe(
      'evidence: the evidence log is not available yet; leave it out',
    );
  });
});

describe('reading the engagement file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dir = () => {
    const made = mkdtempSync(join(tmpdir(), 'nullrivet-engagement-'));
    dirs.push(made);
    return made;
  };

  test('reads a file, and says which one fails and why', async () => {
    const base = dir();
    const path = join(base, 'scope.json');
    writeFileSync(path, JSON.stringify(EXAMPLE));
    const read = await readEngagement(path);
    expect(read.ok ? read.value.name : read.error).toBe('ACME external test');
    writeFileSync(path, JSON.stringify({ scope: { allow: [{ cidr: 'x' }] } }));
    const bad = await readEngagement(path);
    expect(bad.ok ? 'accepted' : bad.error).toBe(
      `the engagement file ${path}: scope.allow[0].cidr: "x" is not an IPv4 or IPv6 address or network`,
    );
    mkdirSync(join(base, 'directory'));
    const directory = await readEngagement(join(base, 'directory'));
    expect(directory.ok ? 'accepted' : directory.error).toContain('not a regular file');
    writeFileSync(path, ' '.repeat(4 * 1024 * 1024 + 1));
    const large = await readEngagement(path);
    expect(large.ok ? 'accepted' : large.error).toContain('larger than 4 MiB');
    const fifo = join(base, 'fifo');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    const pipe = await readEngagement(fifo);
    expect(pipe.ok ? 'accepted' : pipe.error).toContain('not a regular file');
    const missing = await readEngagement(join(base, 'missing.json'));
    expect(missing.ok ? 'accepted' : missing.error).toContain('cannot read the engagement file');
  });
});

test.skipIf(process.platform !== 'linux')(
  'reads no more than the limit of a file whose size does not say it',
  async () => {
    // A file of /proc that says 0 for its size and holds far more than 4 MiB.
    const started = Date.now();
    const read = await readEngagement('/proc/self/pagemap');
    expect(read.ok ? 'accepted' : read.error).toBe(
      'the engagement file is larger than 4 MiB: /proc/self/pagemap',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  },
);

describe('resolving the engagement', () => {
  const resolver = (answers: Record<string, string[]>) => async (host: string) => {
    const found = answers[host];
    if (found === undefined) throw new Error('getaddrinfo ENOTFOUND');
    return found;
  };

  test('authorizes each address a name resolves to with its ports, and gives the sandbox its hosts', async () => {
    const result = await resolveEngagement(
      parsed(EXAMPLE),
      resolver({ 'app.acme.example': ['198.51.100.7', '2001:db8::7', '198.51.100.7', 'garbage'] }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.scope).toEqual({
      allow: [
        { network: { family: 4, address: '203.0.113.0', prefix: 28 }, ports: [80, 443] },
        { network: { family: 4, address: '198.51.100.7', prefix: 32 }, ports: [443] },
        { network: { family: 6, address: '2001:db8:0:0:0:0:0:7', prefix: 128 }, ports: [443] },
      ],
      deny: [{ family: 4, address: '203.0.113.5', prefix: 32 }],
      newConnectionsPerSecond: 20,
      window: {
        from: new Date('2026-11-20T12:00:00.000Z'),
        until: new Date('2026-11-20T21:00:00.000Z'),
      },
    });
    expect(hostsFile(result.value)).toBe(
      '127.0.0.1 localhost\n::1 localhost\n198.51.100.7 app.acme.example\n2001:db8::7 app.acme.example\n',
    );
    expect(describeScope(result.value)).toEqual([
      'Authorized, over TCP and UDP, and ICMP echo:',
      '- 203.0.113.0/28, ports 80, 443',
      '- app.acme.example, ports 443, at 198.51.100.7, 2001:db8::7',
      'Denied, even where authorized: 203.0.113.5/32',
      'At most 20 new connections per second to each address.',
      'Only from 2026-11-20T12:00:00.000Z until 2026-11-20T21:00:00.000Z.',
    ]);
  });

  test('gives a scope the ruleset takes, addresses of both families included', async () => {
    const result = await resolveEngagement(
      parsed(EXAMPLE),
      resolver({ 'app.acme.example': ['198.51.100.7', '2001:db8::7'] }),
    );
    if (!result.ok) throw new Error(result.error);
    const text = rulesetFor(result.value.scope, 'nullrivet_a', null).join('');
    expect(text).toContain('203.0.113.0/28 . 80, 198.51.100.7/32 . 443, 203.0.113.0/28 . 443');
    expect(text).toContain('2001:db8:0:0:0:0:0:7/128 . 443');
    expect(text).toContain('elements = { 203.0.113.5/32 }');
  });

  test('stops at a scope larger than the ruleset installs in the time a helper has', async () => {
    const allow = Array.from({ length: 10_001 }, (_, i) => ({
      cidr: `10.${Math.floor(i / 256)}.${i % 256}.0/24`,
      ports: [80, 443],
    }));
    const result = await resolveEngagement(parsed({ scope: { allow } }));
    expect(result.ok ? 'resolved' : result.error).toStartWith(
      'the scope holds 20002 destinations, more than 20000',
    );
    const fits = await resolveEngagement(parsed({ scope: { allow: allow.slice(1) } }));
    expect(fits.ok).toBe(true);
  });

  test('stops at a name that resolves off the public internet, unless a cidr of the file holds it', async () => {
    const answers = {
      'metadata.example': ['169.254.169.254'],
      'loopback.example': ['127.0.0.1'],
      'inside.example': ['198.51.100.8', '10.1.2.3'],
      'mapped.example': ['::ffff:169.254.169.254'],
      'cloud6.example': ['fd00:ec2::254'],
    };
    const hosts = Object.keys(answers).map((host) => ({ host, ports: [443] }));
    const refused = await resolveEngagement(parsed({ scope: { allow: hosts } }), resolver(answers));
    expect(refused.ok ? 'resolved' : refused.error).toBe(
      "names of the engagement resolve to addresses that are not on the public internet, which a cidr of the file must hold, on the name's ports, to be authorized: " +
        'cloud6.example resolves to fd00:ec2::254 (private); ' +
        'inside.example resolves to 10.1.2.3 (private); ' +
        'loopback.example resolves to 127.0.0.1 (loopback); ' +
        'mapped.example resolves to ::ffff:169.254.169.254 (IPv4-mapped); ' +
        'metadata.example resolves to 169.254.169.254 (link-local, where cloud metadata services answer)',
    );
    // Named by the file: allowed, or denied, which leaves it unreachable.
    const named = await resolveEngagement(
      parsed({
        scope: {
          allow: [
            { host: 'inside.example', ports: [22] },
            { host: 'metadata.example' },
            { cidr: '10.0.0.0/8', ports: [22, 443] },
          ],
          deny: [{ cidr: '169.254.0.0/16' }],
        },
      }),
      resolver(answers),
    );
    expect(named.ok ? named.value.names.map((name) => name.addresses) : named.error).toEqual([
      ['198.51.100.8', '10.1.2.3'],
      ['169.254.169.254'],
    ]);
  });

  test('holds each entry of a name to the rule, a name given twice with other ports included', async () => {
    const result = await resolveEngagement(
      parsed({
        scope: {
          allow: [
            { cidr: '10.0.0.0/8', ports: [443] },
            { host: 'app.example', ports: [22] },
            { host: 'app.example', ports: [443] },
          ],
        },
      }),
      resolver({ 'app.example': ['10.0.0.1'] }),
    );
    expect(result.ok ? 'resolved' : result.error).toEndWith(
      'app.example resolves to 10.0.0.1 (private)',
    );
  });

  test('stops at a name whose ports a cidr holding its internal address does not allow', async () => {
    // The cidr allows 443; the name, every port: the answer would open the rest on 10.0.0.1.
    for (const ports of [undefined, [443, 8080]]) {
      const result = await resolveEngagement(
        parsed({
          scope: {
            allow: [
              { cidr: '10.0.0.0/8', ports: [443] },
              { host: 'app.example', ...(ports === undefined ? {} : { ports }) },
            ],
          },
        }),
        resolver({ 'app.example': ['10.0.0.1'] }),
      );
      expect(result.ok ? 'resolved' : result.error).toEndWith(
        'app.example resolves to 10.0.0.1 (private)',
      );
    }
  });

  test('stops at a name that resolves to an address of this host, or to IPv4 within IPv6', async () => {
    const result = await resolveEngagement(
      parsed({
        scope: {
          allow: ['own', 'nat64', 'local', 'sixtofour', 'compatible'].map((name) => ({
            host: `${name}.example`,
          })),
        },
      }),
      resolver({
        'own.example': ['198.51.100.50'],
        'nat64.example': ['64:ff9b::a9fe:a9fe'],
        'local.example': ['64:ff9b:1::a9fe:a9fe'],
        'sixtofour.example': ['2002:a00:1::1'],
        'compatible.example': ['::a9fe:a9fe'],
      }),
      undefined,
      ['198.51.100.50'],
    );
    const error = result.ok ? 'resolved' : result.error;
    for (const expected of [
      'own.example resolves to 198.51.100.50 (an address of this host)',
      'nat64.example resolves to 64:ff9b::a9fe:a9fe (NAT64)',
      'local.example resolves to 64:ff9b:1::a9fe:a9fe (local NAT64)',
      'sixtofour.example resolves to 2002:a00:1::1 (6to4)',
      'compatible.example resolves to ::a9fe:a9fe (IPv4-compatible)',
    ]) {
      expect(error).toContain(expected);
    }
  });

  test('stops at names not resolved in time, all of them within the time the whole has', async () => {
    const hosts = Array.from({ length: 40 }, (_, i) => ({
      host: `slow${String(i).padStart(2, '0')}.example`,
    }));
    const started = Date.now();
    const result = await resolveEngagement(
      parsed({ scope: { allow: hosts } }),
      () => new Promise<string[]>(() => undefined),
      { lookupMs: 200, totalMs: 500 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    const error = result.ok ? 'resolved' : result.error;
    expect(error).toStartWith(
      'names of the engagement do not resolve: slow00.example: the resolver did not answer within 0.2 s; ',
    );
    // Forty failures: ten listed, the rest counted.
    expect(error).toEndWith('; and 30 more');
    // A lookup is cut at what is left of the whole, shorter than its own limit.
    const cut = await resolveEngagement(
      parsed({ scope: { allow: [{ host: 'slow.example' }] } }),
      () => new Promise<string[]>(() => undefined),
      { lookupMs: 5_000, totalMs: 300 },
    );
    expect(cut.ok ? 'resolved' : cut.error).toBe(
      'names of the engagement do not resolve: slow.example: not resolved within the 0.3 s all names have',
    );
    const late = await resolveEngagement(
      parsed({ scope: { allow: hosts } }),
      async (host) => {
        await Bun.sleep(host.endsWith('39.example') ? 2_000 : 10);
        return ['198.51.100.1'];
      },
      { lookupMs: 1_000, totalMs: 1_500 },
    );
    expect(late.ok ? 'resolved' : late.error).toBe(
      'names of the engagement do not resolve: slow39.example: the resolver did not answer within 1 s',
    );
  });

  test('stops at names that do not resolve, and names them all', async () => {
    const engagement = parsed({
      scope: { allow: [{ host: 'a.example' }, { host: 'b.example' }, { host: 'c.example' }] },
    });
    const result = await resolveEngagement(
      engagement,
      resolver({ 'b.example': ['198.51.100.9'], 'c.example': ['fe80::1%eth0'] }),
    );
    expect(result.ok ? 'resolved' : result.error).toBe(
      'names of the engagement do not resolve: a.example: getaddrinfo ENOTFOUND; c.example: no address',
    );
  });
});

describe('names reached through the proxy', () => {
  const resolver = (answers: Record<string, string[]>) => async (host: string) =>
    answers[host] ?? [];
  const resolved = async (scope: unknown, answers: Record<string, string[]>) => {
    const result = await resolveEngagement(parsed({ scope }), resolver(answers), undefined, []);
    return result.ok ? result.value : result.error;
  };

  test('are marked on a host, and a name is reached one way only', () => {
    expect(error({ scope: { allow: [{ cidr: '203.0.113.0/24', via: 'proxy' }] } })).toBe(
      'scope.allow[0].via: only a host is reached through the proxy: a cidr is reached directly',
    );
    expect(error({ scope: { allow: [{ host: 'app.example', via: 'direct' }] } })).toBe(
      'scope.allow[0].via: must be "proxy"',
    );
    expect(
      error({
        scope: {
          allow: [
            { host: 'app.example', ports: [443], via: 'proxy' },
            { host: 'App.Example', ports: [80] },
          ],
        },
      }),
    ).toBe(
      'scope.allow[1]: app.example is reached through the proxy in scope.allow[0]: a name is reached one way',
    );
  });

  test('get no rule and no line of the hosts file, and are stated as the proxy reaches them', async () => {
    const value = await resolved(
      {
        allow: [
          { host: 'app.example', ports: [443], via: 'proxy' },
          { host: 'direct.example', ports: [22] },
        ],
      },
      { 'app.example': ['198.51.100.7'], 'direct.example': ['198.51.100.9'] },
    );
    if (typeof value === 'string') throw new Error(value);
    expect(value.scope.allow).toEqual([
      { network: { family: 4, address: '198.51.100.9', prefix: 32 }, ports: [22] },
    ]);
    expect(value.names).toEqual([{ host: 'direct.example', addresses: ['198.51.100.9'] }]);
    expect(value.proxied).toEqual([
      { host: 'app.example', ports: [443], addresses: ['198.51.100.7'] },
    ]);
    expect(hostsFile(value)).not.toContain('app.example');
    expect(describeScope(value)).toEqual([
      'Authorized, over TCP and UDP, and ICMP echo:',
      '- direct.example, ports 22, at 198.51.100.9',
      'Authorized by name, through the proxy only, which HTTP_PROXY and HTTPS_PROXY name: HTTPS with the name in TLS, or plain HTTP with it in Host. There is no direct route to these names. The proxy resolves each name again for every connection, and checks the name a connection opens with, not each request inside TLS:',
      '- app.example, ports 443, last checked at 198.51.100.7',
    ]);
  });

  test('stop the session at IPv6 forms that hold an IPv4 address: Teredo, IPv4-translated', async () => {
    expect(
      await resolved(
        { allow: [{ host: 'app.example', ports: [443], via: 'proxy' }] },
        { 'app.example': ['2001:0:4136:e378:8000:63bf:f5ff:fffe', '::ffff:0:a00:1'] },
      ),
    ).toBe(
      'names reached through the proxy must resolve to public addresses the scope does not deny: app.example resolves to 2001:0:4136:e378:8000:63bf:f5ff:fffe, not on the public internet (Teredo); app.example resolves to ::ffff:0:a00:1, not on the public internet (IPv4-translated)',
    );
  });

  test('stop the session at an internal or denied address, which no cidr makes one the proxy reaches', async () => {
    expect(
      await resolved(
        {
          allow: [
            { host: 'app.example', ports: [443], via: 'proxy' },
            { cidr: '10.0.0.0/8', ports: [22] },
          ],
          deny: [{ cidr: '198.51.100.0/24' }],
        },
        { 'app.example': ['10.0.0.1', '198.51.100.7', '203.0.113.9'] },
      ),
    ).toBe(
      'names reached through the proxy must resolve to public addresses the scope does not deny: app.example resolves to 10.0.0.1, not on the public internet (private); app.example resolves to 198.51.100.7, denied by the scope',
    );
  });

  test('stop the session where the direct scope reaches their addresses on their ports', async () => {
    const answers = { 'app.example': ['198.51.100.7'], 'other.example': ['198.51.100.7'] };
    expect(
      await resolved(
        {
          allow: [
            { cidr: '198.51.100.0/24', ports: [443, 8443] },
            { host: 'app.example', ports: [443], via: 'proxy' },
          ],
        },
        answers,
      ),
    ).toBe(
      'names reached through the proxy resolve to addresses the scope authorizes directly, where the sandbox would reach them without it: app.example resolves to 198.51.100.7, which 198.51.100.0/24, ports 443, 8443, authorizes directly',
    );
    // A name reached directly that resolves to the same address is the same way around.
    expect(
      await resolved(
        {
          allow: [{ host: 'other.example' }, { host: 'app.example', ports: [443], via: 'proxy' }],
        },
        answers,
      ),
    ).toBe(
      'names reached through the proxy resolve to addresses the scope authorizes directly, where the sandbox would reach them without it: app.example resolves to 198.51.100.7, which 198.51.100.7/32, every port, authorizes directly',
    );
    // On ports apart, the address is reached directly on its own and through the proxy on the
    // name's.
    const apart = await resolved(
      {
        allow: [
          { cidr: '198.51.100.0/24', ports: [22] },
          { host: 'app.example', ports: [443], via: 'proxy' },
        ],
      },
      answers,
    );
    expect(typeof apart).not.toBe('string');
  });
});

describe('the engagement window', () => {
  test('is open between its times, and always without one', () => {
    const engagement = parsed(EXAMPLE);
    expect(windowState(engagement, new Date('2026-11-20T11:59:59Z'))).toBe('before');
    expect(windowState(engagement, new Date('2026-11-20T12:00:00Z'))).toBe('open');
    expect(windowState(engagement, new Date('2026-11-20T21:00:00Z'))).toBe('after');
    expect(windowState(parsed({ scope: {} }), new Date(0))).toBe('open');
  });
});
