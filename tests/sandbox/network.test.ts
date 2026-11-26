import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxHost } from '../../src/sandbox/bwrap.ts';
import { NetworkControl } from '../../src/sandbox/network/control.ts';
import {
  inNewNamespaces,
  type NetworkTools,
  networkTools,
  runInNamespaces,
} from '../../src/sandbox/network/namespace.ts';
import {
  type Network,
  NOTHING,
  parseNetwork,
  rulesetFor,
  type Scope,
} from '../../src/sandbox/network/ruleset.ts';
import { networkTestsRun } from '../helpers/sandbox.ts';

const net = (text: string): Network => {
  const parsed = parseNetwork(text);
  if (parsed === null) throw new Error(`not a network: ${text}`);
  return parsed;
};

describe('the ruleset of a scope', () => {
  test('parses networks into the full form it writes, host bits cleared', () => {
    expect(parseNetwork('203.0.113.7/28')).toEqual({
      family: 4,
      address: '203.0.113.0',
      prefix: 28,
    });
    expect(parseNetwork('198.51.100.9')).toEqual({
      family: 4,
      address: '198.51.100.9',
      prefix: 32,
    });
    expect(parseNetwork('2001:db8::1/64')).toEqual({
      family: 6,
      address: '2001:db8:0:0:0:0:0:0',
      prefix: 64,
    });
    expect(parseNetwork('::ffff:198.51.100.9')?.address).toBe('0:0:0:0:0:ffff:c633:6409');
    for (const bad of [
      '203.0.113.0/33',
      '2001:db8::/129',
      'fe80::1%eth0',
      '203.0.113.0/28; flush ruleset',
      'app.example',
      '',
      '1.2.3',
    ]) {
      expect(parseNetwork(bad)).toBeNull();
    }
  });

  test('refuses values it did not write: a network out of its form, ports, a rate', () => {
    const forged = { family: 4 as const, address: '1.2.3.4/0 accept', prefix: 32 };
    expect(() => rulesetFor({ allow: [{ network: forged }], deny: [] })).toThrow();
    expect(() =>
      rulesetFor({ allow: [{ network: net('203.0.113.0/28'), ports: [0] }], deny: [] }),
    ).toThrow();
    expect(() =>
      rulesetFor({ allow: [{ network: net('203.0.113.0/28'), ports: [] }], deny: [] }),
    ).toThrow();
    expect(() => rulesetFor({ ...NOTHING, newConnectionsPerSecond: 0.5 })).toThrow();
  });

  test('denies before it allows, and accepts an incoming packet only from where it may go', () => {
    const text = rulesetFor({
      allow: [{ network: net('203.0.113.0/28'), ports: [443] }],
      deny: [net('203.0.113.5')],
      newConnectionsPerSecond: 20,
    });
    const lines = text.split('\n').map((line) => line.trim());
    const at = (start: string) => lines.findIndex((line) => line.startsWith(start));
    expect(at('ip daddr 203.0.113.5/32 goto refuse')).toBeLessThan(at('ip daddr 203.0.113.0/28'));
    expect(at('ct state new meta nfproto ipv4 update @new4')).toBeLessThan(
      at('ip daddr 203.0.113.0/28'),
    );
    // No rule accepts a packet only because its connection is established.
    for (const line of lines.filter((rule) => rule.includes('ct state established'))) {
      expect(line).toContain('saddr 203.0.113.0/28');
    }
    expect(lines.filter((line) => line.includes('policy drop;'))).toHaveLength(2);
    expect(lines[0]).toBe('flush ruleset');
  });
});

// A sandbox in new namespaces, as the security profile starts it, whose command waits until the
// host writes to its block descriptor.
const tools = networkTools();
const hostAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address;

// The sandbox's address and gateway, so that the host's own address is another machine's to it.
const ADDRESS = { address: '10.0.2.15', prefix: 24, gateway: '10.0.2.2' };

// The client the sandbox runs: each check prints one JSON line, [name, outcome].
const CLIENT = `
import json, os, socket, struct, subprocess, sys, time
host, gw, marker, tcp_ok, tcp_other, udp_ok, udp_other, loop_port = sys.argv[1:9]
open(os.path.join(marker, 'ran'), 'w').close()
def out(name, value): print(json.dumps([name, value]), flush=True)
def outcome(e): return type(e).__name__
def tcp(name, addr, port, family=socket.AF_INET, timeout=3):
    s = socket.socket(family); s.settimeout(timeout)
    try: s.connect((addr, int(port))); s.sendall(b'x'); out(name, 'reply ' + s.recv(50).decode())
    except OSError as e: out(name, outcome(e))
    finally: s.close()
def udp(name, addr, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    try: s.sendto(b'x', (addr, int(port))); out(name, 'reply ' + s.recvfrom(50)[0].decode())
    except OSError as e: out(name, outcome(e))
def ping(name, addr):
    try:
        p = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP); p.settimeout(3)
        p.sendto(struct.pack('!BBHHH', 8, 0, 0, 0, 1) + b'ping', (addr, 0)); out(name, 'reply type %d' % p.recvfrom(100)[0][0])
    except OSError as e: out(name, outcome(e))
def run(name, argv):
    try: out(name, subprocess.run(argv, capture_output=True, timeout=10).returncode)
    except OSError as e: out(name, outcome(e))
def wait(name):
    while not os.path.exists(os.path.join(marker, name)): time.sleep(0.05)
mode = sys.argv[9]
if mode == 'probe':
    tcp('tcp allowed', host, tcp_ok)
    tcp('tcp other port', host, tcp_other)
    tcp('tcp host loopback service', host, loop_port)
    tcp('tcp own loopback to host service', '127.0.0.1', loop_port)
    tcp('tcp gateway to host loopback', gw, loop_port)
    tcp('tcp cloud metadata', '169.254.169.254', 80)
    tcp('tcp ipv6', '2001:db8::1', 80, socket.AF_INET6)
    udp('udp allowed', host, udp_ok)
    udp('udp other port', host, udp_other)
    ping('icmp allowed', host)
    ping('icmp other', '192.0.2.1')
    run('nft flush', ['nft', 'flush', 'ruleset'])
    run('sysctl write', ['sh', '-c', 'echo "1 0" > /proc/sys/net/ipv4/ping_group_range'])
    run('new user namespace', ['unshare', '--user', 'true'])
    listener = socket.socket(); listener.bind(('0.0.0.0', 47199)); listener.listen()
    out('listening', 47199); wait('go')
elif mode == 'gateway':
    tcp('tcp gateway to host loopback', gw, loop_port, timeout=2)
elif mode == 'keep':
    s = socket.socket(); s.settimeout(3); s.connect((host, int(tcp_ok)))
    s.sendall(b'1'); out('kept first', s.recv(50).decode()); wait('go')
    try: s.sendall(b'2'); out('kept after', 'reply ' + s.recv(50).decode())
    except OSError as e: out('kept after', outcome(e))
    tcp('tcp allowed after', host, tcp_ok)
elif mode == 'rate':
    made = 0
    for _ in range(10):
        s = socket.socket(); s.settimeout(3)
        try: s.connect((host, int(tcp_ok))); made += 1
        except OSError: pass
        finally: s.close()
    out('rate made', made)
elif mode == 'connected':
    tcp('tcp allowed', host, tcp_ok); wait('go'); tcp('tcp allowed after', host, tcp_ok, timeout=2)
`;

interface Servers {
  tcpOk: number;
  tcpOther: number;
  udpOk: number;
  udpOther: number;
  loopback: number;
  close: () => void;
}

const servers = async (): Promise<Servers> => {
  const opened: (Server | UdpSocket)[] = [];
  const tcpServer = async (host: string, tag: string): Promise<number> => {
    const server = createServer((socket) => {
      socket.on('data', (data) => socket.write(`${tag}${data}`));
      socket.on('error', () => undefined);
    });
    opened.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return (server.address() as { port: number }).port;
  };
  const udpServer = async (): Promise<number> => {
    const socket = createSocket('udp4');
    opened.push(socket);
    socket.on('message', (data, from) => socket.send(`udp${data}`, from.port, from.address));
    await new Promise<void>((resolve) => socket.bind(0, '0.0.0.0', resolve));
    return socket.address().port;
  };
  return {
    tcpOk: await tcpServer('0.0.0.0', 'ok'),
    tcpOther: await tcpServer('0.0.0.0', 'other'),
    udpOk: await udpServer(),
    udpOther: await udpServer(),
    loopback: await tcpServer('127.0.0.1', 'loopback'),
    close: () => {
      for (const server of opened) server.close();
    },
  };
};

interface Sandbox {
  child: ChildProcess;
  pid: number;
  marker: string;
  lines: [string, unknown][];
  release: () => void;
  waitFor: (name: string) => Promise<unknown>;
  ended: Promise<number | null>;
}

const started: Sandbox[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const sandbox of started.splice(0)) {
    if (sandbox.child.exitCode === null) sandbox.child.kill('SIGKILL');
    rmSync(sandbox.marker, { recursive: true, force: true });
  }
});

const startSandbox = (t: NetworkTools, s: Servers, mode: string): Sandbox => {
  const host = sandboxHost();
  if (typeof host === 'string') throw new Error(host);
  const marker = mkdtempSync(join(tmpdir(), 'nullrivet-network-'));
  const uid = String(process.getuid?.() ?? 1000);
  const gid = String(process.getgid?.() ?? 1000);
  const [file, ...args] = inNewNamespaces(t, [
    host.bwrap,
    '--unshare-all',
    '--share-net',
    '--unshare-user',
    '--uid',
    uid,
    '--gid',
    gid,
    '--disable-userns',
    '--cap-drop',
    'ALL',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--bind',
    marker,
    marker,
    '--block-fd',
    '3',
    'python3',
    '-I',
    '-c',
    CLIENT,
    hostAddress as string,
    ADDRESS.gateway,
    marker,
    String(s.tcpOk),
    String(s.tcpOther),
    String(s.udpOk),
    String(s.udpOther),
    String(s.loopback),
    mode,
  ]);
  const child = spawn(file as string, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const lines: [string, unknown][] = [];
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  child.stderr?.on('data', () => undefined);
  const block = child.stdio[3] as NodeJS.WritableStream;
  const sandbox: Sandbox = {
    child,
    pid: child.pid as number,
    marker,
    lines,
    release: () => block.write('x'),
    waitFor: async (name) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const found = lines.find(([line]) => line === name);
        if (found !== undefined) return found[1];
        if (Date.now() > deadline) throw new Error(`no ${name} in ${JSON.stringify(lines)}`);
        await Bun.sleep(20);
      }
    },
    ended: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
  };
  started.push(sandbox);
  return sandbox;
};

const signal = (sandbox: Sandbox, name: string): void =>
  writeFileSync(join(sandbox.marker, name), '');

// The scope of the tests: one TCP and one UDP port of the host's address, and ICMP echo to it.
const hostScope = (s: Servers): Scope => ({
  allow: [{ network: net(hostAddress as string), ports: [s.tcpOk, s.udpOk] }],
  deny: [],
});

const prepared = async (t: NetworkTools, s: Servers, mode: string, scope = hostScope(s)) => {
  const sandbox = startSandbox(t, s, mode);
  // The namespaces exist once the sandbox's process runs Bubblewrap in them.
  await Bun.sleep(200);
  const control = await NetworkControl.prepare(t, sandbox.pid, scope, { address: ADDRESS });
  cleanups.push(() => control.close());
  return { sandbox, control };
};

const pastaOf = (pid: number): number | undefined =>
  readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .find((candidate) => {
      try {
        const cmdline = readFileSync(`/proc/${candidate}/cmdline`, 'utf8').split('\0');
        return (
          cmdline.includes('--netns') &&
          cmdline.includes(`/proc/${pid}/ns/net`) &&
          cmdline.some((arg) => arg.endsWith('pasta'))
        );
      } catch {
        return false;
      }
    });

describe.if(networkTestsRun && process.platform === 'linux')('the network of a sandbox', () => {
  const t = (): NetworkTools => {
    if (typeof tools === 'string') throw new Error(tools);
    if (hostAddress === undefined) throw new Error('the host has no IPv4 address to test with');
    return tools;
  };

  test('lets through what the scope authorizes and refuses the rest at once', async () => {
    const s = await servers();
    cleanups.push(s.close);
    const { sandbox } = await prepared(t(), s, 'probe');
    sandbox.release();
    expect(await sandbox.waitFor('listening')).toBe(47199);
    // Nothing of the namespace is forwarded to the host, even once pasta would have looked for
    // ports to forward, which it does each second when told to.
    await Bun.sleep(2_500);
    for (const address of ['127.0.0.1', hostAddress as string]) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = new Socket();
        socket.once('connect', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => resolve(true));
        socket.connect(47199, address);
      });
      expect(refused).toBe(true);
    }
    signal(sandbox, 'go');
    await sandbox.ended;
    expect(Object.fromEntries(sandbox.lines)).toEqual({
      'tcp allowed': 'reply okx',
      'tcp other port': 'ConnectionRefusedError',
      'tcp host loopback service': 'ConnectionRefusedError',
      'tcp own loopback to host service': 'ConnectionRefusedError',
      'tcp gateway to host loopback': 'ConnectionRefusedError',
      'tcp cloud metadata': 'ConnectionRefusedError',
      'tcp ipv6': expect.stringMatching(/Error$/),
      'udp allowed': 'reply udpx',
      'udp other port': 'PermissionError',
      'icmp allowed': 'reply type 0',
      'icmp other': 'PermissionError',
      'nft flush': 1,
      'sysctl write': 1,
      'new user namespace': 1,
      listening: 47199,
    });
  }, 60_000);

  test('does not map the gateway to the host loopback, even where the scope allows it', async () => {
    const s = await servers();
    cleanups.push(s.close);
    const { sandbox } = await prepared(t(), s, 'gateway', {
      allow: [{ network: net(`${ADDRESS.gateway}/32`) }],
      deny: [],
    });
    sandbox.release();
    await sandbox.ended;
    expect(Object.fromEntries(sandbox.lines)['tcp gateway to host loopback']).not.toMatch(/^reply/);
  }, 60_000);

  test('limits the new connections each destination gets per second', async () => {
    const s = await servers();
    cleanups.push(s.close);
    for (const [rate, expected] of [
      [undefined, 10],
      [2, 'limited'],
    ] as const) {
      const { sandbox } = await prepared(t(), s, 'rate', {
        ...hostScope(s),
        ...(rate === undefined ? {} : { newConnectionsPerSecond: rate }),
      });
      sandbox.release();
      const made = (await sandbox.waitFor('rate made')) as number;
      if (expected === 'limited') {
        // Ten at once, for two a second: the burst the limit allows passes, the rest is refused.
        expect(made).toBeGreaterThanOrEqual(1);
        expect(made).toBeLessThan(10);
      } else {
        expect(made).toBe(expected);
      }
      await sandbox.ended;
    }
  }, 60_000);

  test('cuts an open connection at its next packet once its destination is revoked', async () => {
    const s = await servers();
    cleanups.push(s.close);
    const { sandbox, control } = await prepared(t(), s, 'keep');
    sandbox.release();
    expect(await sandbox.waitFor('kept first')).toBe('ok1');
    await control.replace(NOTHING);
    signal(sandbox, 'go');
    await sandbox.ended;
    const outcome = Object.fromEntries(sandbox.lines);
    expect(outcome['kept after']).toBe('ConnectionResetError');
    expect(outcome['tcp allowed after']).toBe('ConnectionRefusedError');
  }, 60_000);

  test('closes the network, an open connection with it, and ends pasta', async () => {
    const s = await servers();
    cleanups.push(s.close);
    const { sandbox, control } = await prepared(t(), s, 'keep');
    sandbox.release();
    await sandbox.waitFor('kept first');
    await control.close();
    signal(sandbox, 'go');
    await sandbox.ended;
    // Revoked, then without a way out once pasta ended: the connection carries nothing more.
    const outcome = Object.fromEntries(sandbox.lines);
    expect(outcome['kept after']).not.toMatch(/^reply/);
    expect(outcome['tcp allowed after']).not.toMatch(/^reply/);
  }, 60_000);

  test('stays closed when pasta ends, and says so', async () => {
    const s = await servers();
    cleanups.push(s.close);
    const { sandbox, control } = await prepared(t(), s, 'connected');
    sandbox.release();
    expect(await sandbox.waitFor('tcp allowed')).toBe('reply okx');
    const pasta = pastaOf(sandbox.pid);
    expect(pasta).toBeDefined();
    process.kill(pasta as number, 'SIGKILL');
    const deadline = Date.now() + 5_000;
    while (control.failure() === null && Date.now() < deadline) await Bun.sleep(20);
    expect(control.failure()).toContain('pasta exited');
    signal(sandbox, 'go');
    await sandbox.ended;
    expect(Object.fromEntries(sandbox.lines)['tcp allowed after']).not.toMatch(/^reply/);
    expect(pastaOf(sandbox.pid)).toBeUndefined();
  }, 60_000);

  test('never runs the command when the network cannot be prepared', async () => {
    const s = await servers();
    cleanups.push(s.close);
    for (const broken of [
      // The ruleset cannot be installed.
      { ...t(), nft: '/bin/false' },
      // pasta cannot start.
      { ...t(), pasta: '/bin/false' },
    ]) {
      const sandbox = startSandbox(broken, s, 'probe');
      await Bun.sleep(200);
      await expect(
        NetworkControl.prepare(broken, sandbox.pid, hostScope(s), { address: ADDRESS }),
      ).rejects.toThrow();
      // The caller ends the sandbox without releasing it.
      sandbox.child.kill('SIGKILL');
      await sandbox.ended;
      expect(existsSync(join(sandbox.marker, 'ran'))).toBe(false);
    }
  }, 60_000);

  test("runs the helpers without the host's environment, which holds provider keys", async () => {
    const holder = spawn(
      inNewNamespaces(t(), ['sleep', '10'])[0] as string,
      inNewNamespaces(t(), ['sleep', '10']).slice(1),
    );
    cleanups.push(() => {
      holder.kill('SIGKILL');
    });
    await Bun.sleep(200);
    process.env.NULLRIVET_TEST_SECRET = 'key';
    try {
      const seen = await runInNamespaces(t(), holder.pid as number, [
        t().sh,
        '-c',
        'echo "[$NULLRIVET_TEST_SECRET]"',
      ]);
      expect(seen).toBe('[]\n');
    } finally {
      delete process.env.NULLRIVET_TEST_SECRET;
    }
  });

  test("refuses to prepare the host's own namespaces", async () => {
    await expect(NetworkControl.prepare(t(), process.pid, NOTHING)).rejects.toThrow(
      `process ${process.pid} runs in the host's user namespace`,
    );
  });

  test('never runs the command when the sandbox ends before it is released', async () => {
    const s = await servers();
    cleanups.push(s.close);
    const { sandbox } = await prepared(t(), s, 'probe');
    sandbox.child.kill('SIGKILL');
    await sandbox.ended;
    expect(existsSync(join(sandbox.marker, 'ran'))).toBe(false);
  }, 60_000);
});
