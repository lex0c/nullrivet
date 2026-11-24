import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToolCall } from '../../src/agent/tool-broker.ts';
import {
  findBwrap,
  inspectLaunch,
  parseBwrapVersion,
  sandboxEnv,
  sandboxHost,
  sandboxProject,
  trustedExecutable,
} from '../../src/sandbox/bwrap.ts';
import { seccompProgram } from '../../src/sandbox/seccomp.ts';
import { WorkerBackend } from '../../src/sandbox/worker-backend.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import { createJobTools } from '../../src/tools/jobs.ts';
import type { Tool, ToolResult } from '../../src/tools/types.ts';
import { sandboxTestsRun } from '../helpers/sandbox.ts';

const host = sandboxHost();
const runs = sandboxTestsRun;

// As a session starts it: the built-in tools and the job tools, whose jobs live in the worker.
const ALL_TOOLS = [...BUILTIN_TOOLS, ...createJobTools(null, 'one-shot')];
const tool = (name: string): Tool => {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};
const TOOLS = ALL_TOOLS.map((t) => t.name);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-bwrap-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A host home with a key the sandbox must not see, and a project beside it.
const fakeHome = join(scratch, 'home');
const project = join(scratch, 'project');
mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'PRIVATE KEY OF THE HOST\n');
mkdirSync(join(project, '.git'), { recursive: true });
mkdirSync(join(project, 'src'));
writeFileSync(join(project, 'src', 'a.txt'), 'project file\n');
writeFileSync(join(project, '.env'), 'DOTENV_LEAK=loaded\n');
writeFileSync(join(project, 'bunfig.toml'), 'preload = ["./evil.ts"]\n');
writeFileSync(join(project, 'evil.ts'), "await Bun.write('/tmp/evil-ran', 'yes');\n");

const hostEnv = {
  PATH: process.env.PATH,
  HOME: fakeHome,
  LANG: 'C.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-secret-of-the-host',
  OTHER_SECRET: 'other-secret-of-the-host',
};

const startInspect = async (): Promise<WorkerBackend> => {
  if (typeof host === 'string') throw new Error(host);
  const resolved = await sandboxProject(project, hostEnv);
  if ('error' in resolved) throw new Error(resolved.error);
  return WorkerBackend.start({
    launch: inspectLaunch({
      host,
      root: resolved.root,
      cwd: resolved.cwd,
      home: resolved.home,
      hostEnv,
      tools: TOOLS,
      readOnlyDirs: [],
      jobs: 'one-shot',
    }),
    tools: TOOLS,
    jobs: true,
  });
};

const call = (
  backend: WorkerBackend,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> =>
  backend.execute(tool(name), input, { cwd: project, signal: new AbortController().signal });
const sh = async (backend: WorkerBackend, command: string): Promise<string> =>
  (await call(backend, 'bash', { command })).content;

const hostProcessArgs = (): string[] =>
  Bun.spawnSync(['ps', '-eo', 'args']).stdout.toString().split('\n');

describe.if(runs)('the inspect sandbox', () => {
  let backend: WorkerBackend;
  beforeAll(async () => {
    backend = await startInspect();
  });
  afterAll(async () => {
    await backend.close();
  });

  test('the host home is out of reach of every tool', async () => {
    const key = join(fakeHome, '.ssh', 'id_rsa');
    const read = await call(backend, 'read_file', { path: key });
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain('PRIVATE KEY');
    const listed = await call(backend, 'glob', { pattern: '**/*', path: fakeHome });
    expect(listed.content).not.toContain('id_rsa');
    const searched = await call(backend, 'grep', { pattern: 'PRIVATE', path: fakeHome });
    expect(searched.content).not.toContain('PRIVATE KEY');
    const git = await call(backend, 'git', { subcommand: 'status', cwd: join(fakeHome, '.ssh') });
    expect(git.content).not.toContain('id_rsa');
    expect(await sh(backend, `cat ${key}; ls -a ${fakeHome}`)).not.toContain('PRIVATE KEY');
    expect(await sh(backend, `ls -a ${fakeHome}`)).not.toContain('.ssh');
  });

  test('the project is readable and read-only, and writes elsewhere stay inside', async () => {
    expect(
      (await call(backend, 'read_file', { path: join(project, 'src', 'a.txt') })).content,
    ).toContain('project file');
    const write = await call(backend, 'write_file', {
      path: join(project, 'new.txt'),
      content: 'x',
    });
    expect(write.isError).toBe(true);
    expect(existsSync(join(project, 'new.txt'))).toBe(false);
    const marker = `nullrivet-sandbox-${process.pid}`;
    expect(await sh(backend, `echo x > /${marker} 2>&1; echo $?`)).toContain(
      'Read-only file system',
    );
    await sh(backend, `echo x > ~/.bashrc && echo x > /tmp/${marker}`);
    expect(existsSync(join(fakeHome, '.bashrc'))).toBe(false);
    expect(existsSync(join('/tmp', marker))).toBe(false);
  });

  test('no host process, file system or credential is visible', async () => {
    const processes = await sh(backend, 'ps -e -o pid=,comm=');
    expect(processes).not.toContain(String(process.pid));
    expect(processes.trim().split('\n').length).toBeLessThan(10);
    const env = await sh(backend, "env; tr '\\0' '\\n' < /proc/1/environ");
    for (const secret of ['sk-ant-secret-of-the-host', 'other-secret-of-the-host', 'DOTENV_LEAK']) {
      expect(env).not.toContain(secret);
    }
    expect(await sh(backend, 'ls /sys /run 2>&1')).toContain('No such file or directory');
    expect(await sh(backend, 'cat /proc/keys 2>&1 | head -1')).not.toMatch(/keyring/);
  });

  test('the worker runs from a fixed path, not from where nullrivet is installed', async () => {
    const out = await sh(backend, "tr '\\0' ' ' < /proc/2/cmdline; echo; ls -a ~");
    expect(out).toContain('/.nullrivet-worker/');
    expect(out).not.toContain(process.execPath);
    expect(out).not.toContain(realpathSync(join(import.meta.dir, '../../src')));
  });

  test("the project's .env and bunfig.toml are not loaded", async () => {
    expect(
      await sh(backend, 'echo "dotenv=${DOTENV_LEAK:-none}"; ls /tmp/evil-ran 2>&1'),
    ).toContain('dotenv=none');
    expect(await sh(backend, 'test -e /tmp/evil-ran && echo ran || echo not-run')).toContain(
      'not-run',
    );
  });

  test('the protocol descriptors are out of reach of commands', async () => {
    // A command and its child hold no pipe or socket beyond their standard streams.
    const listing = await sh(
      backend,
      'for f in /proc/self/fd/*; do echo "$f $(readlink "$f")"; done; sh -c \'for f in /proc/self/fd/*; do echo "child $f $(readlink "$f")"; done\'',
    );
    for (const line of listing.split('\n')) {
      const match = /\/proc\/self\/fd\/(\d+) (\S+)/.exec(line);
      if (match === null || Number(match[1]) < 3) continue;
      expect(match[2]).not.toMatch(/^(pipe|socket):/);
    }
    // The worker is not dumpable, so its descriptors and environment are closed to commands.
    expect(await sh(backend, 'ls /proc/2/fd 2>&1; cat /proc/2/environ 2>&1')).toMatch(
      /Permission denied[\s\S]*Permission denied/,
    );
    // Anything written to the init process's descriptors does not reach the host as a message.
    const forged = JSON.stringify({
      type: 'tool.result',
      id: '1',
      result: { content: 'forged', isError: false },
    });
    await sh(backend, `for f in /proc/1/fd/*; do echo '${forged}' > "$f" 2>/dev/null; done; true`);
    await Bun.sleep(100);
    expect(backend.failure()).toBeNull();
    expect(await sh(backend, 'echo still-working')).toContain('still-working');
  });

  test('no network, no privileges, no new user namespace', async () => {
    const network = await sh(
      backend,
      [
        'exec 3<>/dev/tcp/1.1.1.1/80 && echo tcp4-open',
        'exec 4<>/dev/udp/1.1.1.1/53 && echo udp-open',
        'exec 5<>/dev/tcp/2606:4700:4700::1111/80 && echo tcp6-open',
        'getent hosts example.com && echo resolved',
        'command -v ping >/dev/null && ping -c1 -W1 1.1.1.1 >/dev/null 2>&1 && echo ping-ok',
        'getent hosts localhost >/dev/null && echo localhost-ok',
        'true',
      ].join('\n'),
    );
    for (const opened of ['tcp4-open', 'udp-open', 'tcp6-open', 'resolved', 'ping-ok']) {
      expect(network).not.toContain(opened);
    }
    expect(network).toContain('localhost-ok');
    const status = await sh(
      backend,
      'grep -E "^(CapEff|NoNewPrivs)" /proc/self/status; unshare -U true 2>/dev/null || echo unshare-failed',
    );
    expect(status).toMatch(/CapEff:\s+0+\b/);
    expect(status).toMatch(/NoNewPrivs:\s+1/);
    expect(status).toContain('unshare-failed');
  });

  test('the seccomp program denies keyrings, the x32 ABI, io_uring and sockets other than IP', async () => {
    const python = [
      'import ctypes, errno, socket',
      'libc = ctypes.CDLL(None, use_errno=True)',
      'for name, nr in (("keyctl", 250), ("x32", 0x40000000 | 250)):',
      '    libc.syscall(nr, 0, -4, 0)',
      '    print(name, errno.errorcode.get(ctypes.get_errno()))',
      // io_uring_setup has the same number on both architectures. Without the program, a call with
      // no parameters fails with another error than EPERM.
      'libc.syscall(425, 0, 0)',
      'print("io_uring", errno.errorcode.get(ctypes.get_errno()))',
      // Families are allowed by name. Without the program, vsock fails with EAFNOSUPPORT where
      // its module is not loaded, and AF_ALG and the uevent netlink protocol succeed.
      'families = (("unix", socket.AF_UNIX, socket.SOCK_STREAM, 0),',
      '    ("vsock", socket.AF_VSOCK, socket.SOCK_STREAM, 0),',
      '    ("alg", socket.AF_ALG, socket.SOCK_SEQPACKET, 0),',
      '    ("uevent", socket.AF_NETLINK, socket.SOCK_DGRAM, 15),',
      '    ("route", socket.AF_NETLINK, socket.SOCK_DGRAM, 0),',
      '    ("inet", socket.AF_INET, socket.SOCK_STREAM, 0),',
      '    ("inet6", socket.AF_INET6, socket.SOCK_STREAM, 0))',
      'for name, family, kind, protocol in families:',
      '    try:',
      '        socket.socket(family, kind, protocol).close()',
      '        print(name, "created")',
      '    except OSError as e:',
      '        print(name, errno.errorcode[e.errno])',
      'socket.socketpair()',
      'print("socketpair", "ok")',
    ].join('\n');
    const out = await sh(backend, `python3 -c '${python}'`);
    if (process.arch === 'x64') {
      expect(out).toContain('keyctl EPERM');
      expect(out).toContain('x32 EPERM');
    }
    expect(out).toContain('io_uring EPERM');
    for (const denied of ['unix', 'vsock', 'alg', 'uevent'])
      expect(out).toContain(`${denied} EPERM`);
    for (const allowed of ['route', 'inet', 'inet6']) expect(out).toContain(`${allowed} created`);
    expect(out).toContain('socketpair ok');
  });

  test('a host Unix socket inside the project, created after the start, gets no connection', async () => {
    let connections = 0;
    const path = join(project, 'control.sock');
    const server = Bun.listen({
      unix: path,
      socket: {
        open: () => {
          connections += 1;
        },
        data: () => undefined,
      },
    });
    try {
      const out = await sh(
        backend,
        `python3 -c 'import socket; socket.socket(socket.AF_UNIX).connect("${path}")' 2>&1 | tail -1`,
      );
      expect(out).toContain('PermissionError');
      await Bun.sleep(100);
      expect(connections).toBe(0);
    } finally {
      server.stop(true);
      rmSync(path, { force: true });
    }
  });

  test('the broker hands calls to the sandboxed worker', async () => {
    const result = await executeToolCall(
      { id: 'c', name: 'read_file', input: { path: join(project, 'src', 'a.txt') } },
      {
        tools: new Map([['read_file', tool('read_file')]]),
        mode: 'readonly',
        cwd: project,
        signal: new AbortController().signal,
        backend,
      },
    );
    expect(result.content).toContain('project file');
  });
});

describe.if(runs)('the end of the inspect sandbox', () => {
  const leftover = (marker: string) => hostProcessArgs().some((args) => args.includes(marker));
  // The command waits until the process it leaves runs in its own session: the tool signals the
  // command's process group once the command exits, which would kill a child that had not yet
  // left it. Then this waits until the host sees the process.
  const leave = async (backend: WorkerBackend, marker: string): Promise<void> => {
    const ready = `/tmp/left-${marker}`;
    await sh(
      backend,
      `setsid sh -c 'trap "" TERM; touch ${ready}; exec sleep ${marker}' >/dev/null 2>&1 & ` +
        `for i in $(seq 100); do [ -e ${ready} ] && break; sleep 0.05; done; echo started`,
    );
    const deadline = Date.now() + 5_000;
    while (!leftover(`sleep ${marker}`) && Date.now() < deadline) await Bun.sleep(50);
  };

  test('a background job runs in the sandbox, its log is readable there, and it ends with it', async () => {
    const backend = await startInspect();
    const started = await call(backend, 'bash_background', {
      command: `echo from-the-job; ls /run 2>&1; setsid sh -c 'trap "" TERM; exec sleep 31337.3' >/dev/null 2>&1 & sleep 60`,
    });
    const logPath = /\[log so far \([^)]*\) saved to `([^`]+)`/.exec(started.content)?.[1];
    expect(logPath).toStartWith('/tmp/nullrivet-');
    const deadline = Date.now() + 5_000;
    while (!leftover('sleep 31337.3') && Date.now() < deadline) await Bun.sleep(50);
    const log = await call(backend, 'read_file', { path: logPath });
    expect(log.content).toContain('from-the-job');
    expect(log.content).toContain('No such file or directory');
    // The log is in the sandbox's own /tmp, not the host's.
    expect(existsSync(logPath ?? '')).toBe(false);
    expect(leftover('sleep 31337.3')).toBe(true);
    expect(backend.jobs?.running()).toBe(1);
    await backend.close();
    await Bun.sleep(200);
    expect(leftover('sleep 31337.3')).toBe(false);
  });

  test('a process left behind ends when the sandbox is closed', async () => {
    const backend = await startInspect();
    await leave(backend, '31337.1');
    expect(leftover('sleep 31337.1')).toBe(true);
    await backend.close();
    await Bun.sleep(200);
    expect(leftover('sleep 31337.1')).toBe(false);
  });

  test('signals that a command sends to the worker by name, such as pkill bun, do not end it', async () => {
    const backend = await startInspect();
    await call(backend, 'bash_background', { command: 'sleep 30' });
    const out = await sh(
      backend,
      'pkill bun; pkill -f main.ts; pkill -HUP -f nullrivet; pkill -QUIT bun; sleep 0.3; echo still-here',
    );
    expect(out).toContain('still-here');
    expect(backend.failure()).toBeNull();
    expect(await sh(backend, 'echo answering')).toContain('answering');
    expect(backend.jobs?.running()).toBe(1);
    await backend.close();
  });

  test('killing the worker from inside loses the backend and ends every process', async () => {
    const backend = await startInspect();
    await leave(backend, '31337.2');
    await expect(call(backend, 'bash', { command: 'kill -9 2; sleep 5' })).rejects.toThrow();
    expect(backend.failure()).not.toBeNull();
    await Bun.sleep(200);
    expect(leftover('sleep 31337.2')).toBe(false);
    await backend.close();
  });
});

describe('the project root of a sandbox', () => {
  const resolve = (cwd: string, env: Record<string, string> = {}) =>
    sandboxProject(cwd, { HOME: fakeHome, ...env });

  test('is the repository root above the working directory', async () => {
    expect(await resolve(join(project, 'src'))).toEqual({
      root: project,
      cwd: join(project, 'src'),
      home: fakeHome,
    });
  });

  test('is refused when it is or contains the home directory or a sensitive directory', async () => {
    expect(await resolve(fakeHome)).toMatchObject({
      error: expect.stringContaining('the home directory'),
    });
    expect(await resolve(scratch)).toMatchObject({
      error: expect.stringContaining('the home directory'),
    });
    expect(await resolve('/')).toMatchObject({
      error: expect.stringContaining('the whole filesystem'),
    });
    const runtime = join(project, 'run');
    mkdirSync(runtime, { recursive: true });
    expect(await resolve(project, { XDG_RUNTIME_DIR: runtime })).toMatchObject({
      error: expect.stringContaining(runtime),
    });
  });
});

describe('the sandbox launch', () => {
  test('starts from an environment built from nothing', () => {
    expect(
      sandboxEnv(
        {
          PATH: './bin:/usr/bin',
          HOME: '/h',
          LANG: 'C',
          LC_TIME: 'C',
          OPENAI_API_KEY: 'k',
          TERM: 'x',
        },
        '/h',
      ),
    ).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
      HOME: '/h',
      TMPDIR: '/tmp',
      LANG: 'C',
      LC_TIME: 'C',
    });
  });

  test('takes bwrap only from a file that only root can replace, never from PATH', () => {
    const dir = join(scratch, 'bin');
    mkdirSync(dir, { recursive: true });
    // A file of the user, as a project's node_modules/.bin could hold.
    writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
    expect(trustedExecutable(join(dir, 'bwrap'))).toBeNull();
    expect(findBwrap([join(dir, 'bwrap')])).toBeNull();
    expect(trustedExecutable('/nonexistent/bwrap')).toBeNull();
    // A link resolves to its target, which is what runs.
    const env = realpathSync('/usr/bin/env');
    symlinkSync('/usr/bin/env', join(dir, 'env-link'));
    expect(trustedExecutable(join(dir, 'env-link'))).toBe(env);
    expect(findBwrap([join(dir, 'bwrap'), '/usr/bin/env'])).toBe(env);
  });

  test('refuses a missing Bubblewrap and one that does not report a version of 0.8 or later', () => {
    expect(parseBwrapVersion('bubblewrap 0.9.0\n')).toEqual([0, 9, 0]);
    expect(parseBwrapVersion('bwrap: Unknown option --version')).toBeNull();
    if (process.platform !== 'linux') {
      expect(sandboxHost(['/nonexistent/bwrap'])).toBe(
        'sandbox profiles need Linux, where they use Bubblewrap',
      );
      return;
    }
    expect(sandboxHost(['/nonexistent/bwrap'])).toContain(
      'need Bubblewrap (bwrap) in a system directory owned by root: /nonexistent/bwrap',
    );
    // A trusted executable that is not Bubblewrap reports no version it understands.
    // Named by its real path, which can differ: /usr/bin/true is a link to gnutrue on some systems.
    expect(sandboxHost(['/usr/bin/true'])).toContain(
      `or later; ${realpathSync('/usr/bin/true')} is an unknown version`,
    );
  });

  test('the seccomp program is the one checked against the kernel', () => {
    expect(Buffer.from(seccompProgram('x64')).toString('hex')).toBe(
      [
        '2000000004000000',
        '150000113e0000c0',
        '2000000000000000',
        '45000e0000000040',
        '15000d00fa000000',
        '15000c00f8000000',
        '15000b00f9000000',
        '15000a00a9010000',
        '15000900aa010000',
        '15000800ab010000',
        '1500000629000000',
        '2000000010000000',
        '1500040002000000',
        '150003000a000000',
        '1500000310000000',
        '2000000020000000',
        '1500000100000000',
        '060000000000ff7f',
        '0600000001000500',
        '0600000026000500',
      ].join(''),
    );
    // No x32 ABI on arm64, so one instruction less.
    expect(seccompProgram('arm64').length).toBe(19 * 8);
  });
});
