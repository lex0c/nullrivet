import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { findBwrap } from '../../src/sandbox/bwrap.ts';
import { prepareLimits } from '../../src/sandbox/limits.ts';
import { GIVEN_UP } from '../../src/sandbox/network/namespace.ts';
import type { ProxyEvent } from '../../src/sandbox/network/proxy.ts';
import {
  PROXY_PROCESS_LIMITS,
  proxyProcess,
  type RunningProxy,
} from '../../src/sandbox/network/proxy-process.ts';
import { type SyscallArch, sandboxArch } from '../../src/sandbox/seccomp.ts';
import { cgroupTestsRun } from '../helpers/sandbox.ts';

const TOKEN = 'b'.repeat(64);
const AUTH = `Proxy-Authorization: Basic ${Buffer.from(`nullrivet:${TOKEN}`).toString('base64')}`;

let units = 0;
const running: RunningProxy[] = [];
afterEach(async () => {
  for (const proxy of running.splice(0)) await proxy.stop().catch(() => undefined);
});

const start = async (events: ProxyEvent[] = []) => {
  const limited = await prepareLimits(process.env);
  if (limited.scope === undefined || limited.clean === undefined) throw new Error('no cgroup');
  units += 1;
  const unit = `nullrivet-proxy-test-${process.pid}-${units}.scope`;
  const proxy = await proxyProcess({
    bwrap: findBwrap() as string,
    arch: sandboxArch() as SyscallArch,
    clean: limited.clean,
    scope: {
      prefix: limited.scope(unit, PROXY_PROCESS_LIMITS),
      env: limited.env,
      unit,
      limits: PROXY_PROCESS_LIMITS,
    },
  })({
    policy: {
      token: TOKEN,
      names: [{ host: 'localhost', ports: [80] }],
      direct: { allow: [], deny: [] },
    },
    report: (event) => events.push(event),
  });
  running.push(proxy);
  return { proxy, unit };
};

const ask = (port: number, request: string): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    const socket: Socket = connect({ host: '127.0.0.1', port }, () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.on('close', () => resolve(text));
    socket.on('error', () => undefined);
  });

const pidsOf = (unit: string): number[] => {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cgroup`, 'utf8').includes(`/${unit}\n`))
        pids.push(Number(entry));
    } catch {
      // Gone meanwhile.
    }
  }
  return pids;
};

describe.if(cgroupTestsRun)('the proxy as a process of its own', () => {
  test('holds its policy, with the resolver of the host, in its scope with its limits', async () => {
    const events: ProxyEvent[] = [];
    const { proxy, unit } = await start(events);
    expect(proxy.port).toBeGreaterThan(0);
    expect(await ask(proxy.port, 'CONNECT localhost:80 HTTP/1.1\r\n\r\n')).toStartWith(
      'HTTP/1.1 407 ',
    );
    // localhost resolves, through the host's resolver, to the loopback: never reached.
    const refused = await ask(proxy.port, `CONNECT localhost:80 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
    expect(refused).toStartWith('HTTP/1.1 403 ');
    expect(refused).toMatch(
      /localhost resolves to (127\.0\.0\.1|::1), not on the public internet \(loopback\)/,
    );
    expect(events.map((event) => event.type)).toEqual(['refused', 'refused']);
    const path = readFileSync(`/proc/${pidsOf(unit)[0]}/cgroup`, 'utf8')
      .trim()
      .slice(3);
    expect(readFileSync(`/sys/fs/cgroup${path}/cpu.max`, 'utf8').trim()).toBe('50000 100000');
    expect(readFileSync(`/sys/fs/cgroup${path}/pids.max`, 'utf8').trim()).toBe(
      String(PROXY_PROCESS_LIMITS.tasks),
    );
  }, 30_000);

  test("sees none of the user's files, opens no Unix socket, holds none of the host's environment, and no command line holds its credential", async () => {
    const { unit } = await start();
    const pids = pidsOf(unit);
    expect(pids.length).toBeGreaterThan(1);
    for (const pid of pids) {
      expect(readFileSync(`/proc/${pid}/cmdline`, 'utf8')).not.toContain(TOKEN);
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
      expect(environ).not.toContain(TOKEN);
      expect(environ).not.toContain('XDG_RUNTIME_DIR=');
      expect(environ).not.toContain('DBUS_SESSION_BUS_ADDRESS=');
    }
    // The proxy itself, Bubblewrap's child: its root holds the system and not the home.
    const inner = pids.find((pid) => readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'bwrap');
    // Under the sandbox's seccomp program, which refuses the Unix sockets the shared network
    // namespace would otherwise reach, the X server's abstract one among them.
    expect(readFileSync(`/proc/${inner}/status`, 'utf8')).toMatch(/^Seccomp:\s+2$/m);
    expect(existsSync(`/proc/${inner}/root/usr/bin`)).toBe(true);
    expect(existsSync(`/proc/${inner}/root${homedir()}`)).toBe(false);
    expect(existsSync(`/proc/${inner}/root${process.cwd()}`)).toBe(false);
  }, 30_000);

  test('gives up a start whose signal was aborted already, leaving no scope', async () => {
    const limited = await prepareLimits(process.env);
    if (limited.scope === undefined || limited.clean === undefined) throw new Error('no cgroup');
    units += 1;
    const unit = `nullrivet-proxy-test-${process.pid}-${units}.scope`;
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      proxyProcess({
        bwrap: findBwrap() as string,
        arch: sandboxArch() as SyscallArch,
        clean: limited.clean,
        scope: {
          prefix: limited.scope(unit, PROXY_PROCESS_LIMITS),
          env: limited.env,
          unit,
          limits: PROXY_PROCESS_LIMITS,
        },
      })({
        policy: { token: TOKEN, names: [{ host: 'localhost' }], direct: { allow: [], deny: [] } },
        report: () => undefined,
        signal: aborted.signal,
      }),
    ).rejects.toThrow(GIVEN_UP);
    expect(pidsOf(unit)).toEqual([]);
  }, 30_000);

  test('ends with its scope on the end of its input, and tells why when killed', async () => {
    const { proxy, unit } = await start();
    await proxy.stop();
    expect(await proxy.ended).toBe('the proxy was stopped');
    expect(pidsOf(unit)).toEqual([]);
    const other = await start();
    for (const pid of pidsOf(other.unit)) process.kill(pid, 'SIGKILL');
    expect(await other.proxy.ended).toMatch(/^the proxy exited on SIGKILL/);
  }, 30_000);
});
