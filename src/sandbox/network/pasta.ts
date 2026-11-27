import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { errorMessage } from '../../errors.ts';
import { cgroupLimits, type Limits, missingLimits } from '../limits.ts';
import {
  enterArgs,
  GIVEN_UP,
  HELPER_ENV,
  holdsNetwork,
  type Namespaces,
  type NetworkTools,
  runInNamespaces,
} from './namespace.ts';

// pasta connects a sandbox's network namespace to the host's network, translating its TCP, UDP and
// ICMP echo flows into sockets of the host. It runs in the namespaces' user namespace, which gives
// it the capabilities to configure the network namespace, and stays in the host's network.
//
// Nothing is forwarded but what the sandbox opens: no port of the host leads into the namespace,
// and none of the namespace's to the host, in either protocol (`-t none -u none -T none -U none`).
// The gateway's address is not mapped to the host's loopback (`--no-map-gw`), which would
// otherwise reach the host's own services, and DHCP is not offered. A pasta that ends leaves the
// namespace without a way out: it is never started again. pasta ends by itself once the process
// whose namespace it serves is gone, so a host killed with SIGKILL, whose sandbox ends with it,
// leaves no pasta behind.

export interface PastaAddress {
  // The namespace's IPv4 address, prefix and gateway. Without them pasta copies the host's
  // address, under which the namespace cannot reach the host's own address.
  address: string;
  prefix: number;
  gateway: string;
}

const READY_TIMEOUT_MS = 10_000;
const POLL_MS = 20;
const SETTLE_MS = 50;
const STOP_GRACE_MS = 2_000;
const EMPTIED_TIMEOUT_MS = 5_000;
const PASTA_NAMES = /^pas(?:ta|st)(?:\.avx2)?$/;

// What pasta may take, beside the sandbox's own limits: it holds a few buffers per connection, in
// one thread.
export const PASTA_LIMITS: Limits = { tasks: 8, memoryBytes: 256 * 1024 * 1024, cpuWeight: 20 };

// A scope of the user's service manager for pasta alone, so that traffic to and from the targets
// costs it what its own limits allow, and its end can be confirmed whole.
export interface PastaScope {
  // What starts pasta in the scope, named `unit`.
  prefix: readonly string[];
  // For that command alone.
  env: Record<string, string>;
  unit: string;
  limits: Limits;
}

// The cgroup of the unit named, found through any process in it: when what started pasta did not
// run it in place, pasta runs there without being the process followed.
const unitCgroup = (unit: string): string | null => {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const path = cgroupOf(Number(entry));
    if (path?.endsWith(`/${unit}`) === true) return path;
  }
  return null;
};

// The cgroup `pid` runs in, or null once it is gone.
const cgroupOf = (pid: number): string | null => {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((row) => row.startsWith('0::'));
    return line === undefined ? null : line.slice(3);
  } catch {
    return null;
  }
};

// Kills every process of the cgroup at `path` and its descendants, and resolves once none is
// left, or the cgroup is gone: the manager removes a scope that has no process.
const emptied = async (path: string): Promise<void> => {
  const dir = `/sys/fs/cgroup${path}`;
  try {
    writeFileSync(`${dir}/cgroup.kill`, '1');
  } catch {
    // Gone already, or not writable: what is left shows below.
  }
  const deadline = Date.now() + EMPTIED_TIMEOUT_MS;
  for (;;) {
    let events: string;
    try {
      events = readFileSync(`${dir}/cgroup.events`, 'utf8');
    } catch {
      return;
    }
    if (/^populated 0$/m.test(events)) return;
    if (Date.now() > deadline) {
      throw new Error(`the scope of pasta, ${path}, still holds processes`);
    }
    await Bun.sleep(POLL_MS);
  }
};

// Whether routes, as /proc/net/route and /proc/net/ipv6_route list them, go through an interface
// other than the loopback, which pasta adds once it configured the namespace: a default one, or
// only those of the host's own networks, as in a laboratory without a gateway. A namespace with
// only its loopback already lists IPv6 routes through it, among them a default one that refuses
// everything; link-local and multicast routes come with any interface that is up, configured or
// not.
export const routedOut = (v4: string, v6: string): boolean =>
  v4
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'))
    .some((fields) => fields.length > 1 && fields[0]?.trim() !== 'lo') ||
  v6
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .some(
      (fields) =>
        fields.length === 10 &&
        fields[9] !== 'lo' &&
        !(fields[0] ?? '').startsWith('fe80') &&
        !(fields[0] ?? '').startsWith('ff'),
    );

// A kernel without IPv6 has no ipv6_route, and a process that ended neither file.
const routes = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const configured = (pid: number): boolean =>
  routedOut(routes(`/proc/${pid}/net/route`), routes(`/proc/${pid}/net/ipv6_route`));

// The routes of the pinned network namespace, read from inside it, with the shell's builtins.
const ROUTES = [
  'for file in /proc/self/net/route /proc/self/net/ipv6_route; do',
  '  if [ -r "$file" ]; then while IFS= read -r line; do echo "$line"; done < "$file"; fi',
  '  echo --',
  'done',
].join('\n');

// Whether pasta can relay ICMP echo, which it does with ICMP echo sockets of the host: the host's
// ping group range must hold one of the user's groups. Without it, TCP and UDP still pass, and
// echo requests get no reply.
export const hostRelaysEcho = (): boolean => {
  try {
    const [low, high] = readFileSync('/proc/sys/net/ipv4/ping_group_range', 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    const groups = [process.getgid?.(), ...(process.getgroups?.() ?? [])];
    return groups.some(
      (group) =>
        group !== undefined &&
        low !== undefined &&
        high !== undefined &&
        group >= low &&
        group <= high,
    );
  } catch {
    return false;
  }
};

export class Pasta {
  // Why pasta ended; settles only when it does.
  readonly ended: Promise<string>;
  private stopping = false;
  // The cgroup of pasta's scope, once confirmed.
  private cgroup: string | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly scope: PastaScope | undefined,
  ) {
    this.ended = new Promise((resolve) => {
      let output = '';
      const collect = (chunk: Buffer): void => {
        if (output.length < 500) output += chunk.toString();
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => resolve(`pasta could not start: ${error.message}`));
      child.once('exit', (code, signal) => {
        const how = signal === null ? `with code ${code}` : `on ${signal}`;
        resolve(
          this.stopping
            ? 'pasta was stopped'
            : `pasta exited ${how}${output.trim() === '' ? '' : `: ${output.trim().slice(0, 300)}`}`,
        );
      });
    });
  }

  // Starts pasta for the namespaces, in `scope` when given, and resolves once the network namespace
  // pinned is configured and the scope confirmed.
  static async start(
    tools: NetworkTools,
    namespaces: Namespaces,
    address?: PastaAddress,
    scope?: PastaScope,
    signal?: AbortSignal,
  ): Promise<Pasta> {
    const { pid } = namespaces;
    if (!holdsNetwork(namespaces)) {
      throw new Error(`process ${pid} no longer runs in the network namespace pinned`);
    }
    const [file, ...args] = [
      ...(scope?.prefix ?? []),
      ...enterArgs(tools, namespaces, false),
      tools.pasta,
      '--foreground',
      '--quiet',
      '--config-net',
      '--no-map-gw',
      '--no-dhcp',
      '--no-dhcpv6',
      '-t',
      'none',
      '-u',
      'none',
      '-T',
      'none',
      '-U',
      'none',
      ...(address === undefined
        ? []
        : ['-a', address.address, '-n', String(address.prefix), '-g', address.gateway]),
      '--netns',
      `/proc/${pid}/ns/net`,
      '--netns-only',
    ];
    const child = spawn(file as string, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...HELPER_ENV, ...(scope?.env ?? {}) },
      // Out of the terminal's process group: an interrupt there is the host's to handle.
      detached: true,
    });
    const pasta = new Pasta(child, scope);
    try {
      await pasta.ready(tools, namespaces, signal);
    } catch (error) {
      await pasta.discard(error);
    }
    return pasta;
  }

  private async ready(
    tools: NetworkTools,
    namespaces: Namespaces,
    signal?: AbortSignal,
  ): Promise<void> {
    const { pid } = namespaces;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ended: string | null = null;
    void this.ended.then((reason) => {
      ended = reason;
    });
    while (!configured(pid)) {
      if (ended !== null) throw new Error(ended);
      if (signal?.aborted === true) throw new Error(GIVEN_UP);
      if (Date.now() > deadline) {
        throw new Error(`pasta did not configure the namespace within ${READY_TIMEOUT_MS} ms`);
      }
      await Bun.sleep(POLL_MS);
    }
    // A pasta that configured the namespace and ended right after is not a way out: it is checked
    // once more, after its exit had the time to be seen. pasta was given the namespace by the
    // process's id: the namespace configured must be the one pinned.
    await Bun.sleep(SETTLE_MS);
    if (ended !== null) throw new Error(ended);
    const [v4 = '', v6 = ''] = (
      await runInNamespaces(tools, namespaces, [tools.sh, '-c', ROUTES], '', signal)
    ).split('--\n');
    if (!holdsNetwork(namespaces) || !routedOut(v4, v6)) {
      throw new Error('pasta did not configure the network namespace pinned');
    }
    if (this.scope !== undefined) this.confirmScope(this.scope);
  }

  // The process followed is pasta itself, run in place by what started it, in the scope named,
  // which holds the limits asked for: otherwise pasta would be unfollowed, or unlimited.
  private confirmScope(scope: PastaScope): void {
    const pid = this.child.pid as number;
    // pasta runs again as passt.avx2 where the processor has those instructions.
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    if (!PASTA_NAMES.test(comm)) throw new Error(`the process followed runs ${comm}, not pasta`);
    const path = cgroupOf(pid);
    if (path === null || !path.endsWith(`/${scope.unit}`)) {
      throw new Error(`pasta does not run in the scope ${scope.unit}`);
    }
    this.cgroup = path;
    const wrong = missingLimits(cgroupLimits(path), scope.limits);
    if (wrong.length > 0) {
      throw new Error(`the scope of pasta does not hold its limits: ${wrong.join('; ')}`);
    }
  }

  // Ends a pasta that did not start as it must, with its scope, and rejects with why.
  private async discard(error: unknown): Promise<never> {
    this.stopping = true;
    this.kill();
    await this.ended;
    const path = this.cgroup ?? (this.scope === undefined ? null : unitCgroup(this.scope.unit));
    if (path !== null) {
      try {
        await emptied(path);
      } catch (left) {
        throw new Error(`${errorMessage(error)}; ${errorMessage(left)}`);
      }
    }
    throw error;
  }

  // Ends pasta, and resolves once its scope holds no process: rejects when one is left.
  async stop(): Promise<void> {
    this.stopping = true;
    this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill(), STOP_GRACE_MS);
    await this.ended;
    clearTimeout(timer);
    if (this.cgroup !== null) await emptied(this.cgroup);
  }

  private kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      process.kill(child.pid, signal);
    } catch {
      // Already gone.
    }
  }
}
