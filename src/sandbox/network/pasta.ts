import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { enterArgs, HELPER_ENV, type NetworkTools } from './namespace.ts';

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
const STOP_GRACE_MS = 2_000;

// Whether the namespace of `pid` has a route through an interface other than the loopback, which
// pasta adds once it configured the namespace: a default one, or only those of the host's own
// networks, as in a laboratory without a gateway. A namespace with only its loopback already
// lists IPv6 routes through it, among them a default one that refuses everything; link-local and
// multicast routes come with any interface that is up, configured or not.
const configured = (pid: number): boolean => {
  try {
    const v4 = readFileSync(`/proc/${pid}/net/route`, 'utf8')
      .split('\n')
      .slice(1)
      .map((line) => line.split('\t'))
      .some((fields) => fields.length > 1 && fields[0]?.trim() !== 'lo');
    if (v4) return true;
    return readFileSync(`/proc/${pid}/net/ipv6_route`, 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .some(
        (fields) =>
          fields.length === 10 &&
          fields[9] !== 'lo' &&
          !(fields[0] ?? '').startsWith('fe80') &&
          !(fields[0] ?? '').startsWith('ff'),
      );
  } catch {
    return false;
  }
};

export class Pasta {
  // Why pasta ended; settles only when it does.
  readonly ended: Promise<string>;
  private stopping = false;

  private constructor(private readonly child: ChildProcess) {
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

  // Starts pasta for the namespaces of `pid`, and resolves once the namespace is configured.
  static async start(tools: NetworkTools, pid: number, address?: PastaAddress): Promise<Pasta> {
    const [file, ...args] = [
      ...enterArgs(tools, pid, false),
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
      env: HELPER_ENV,
      // Out of the terminal's process group: an interrupt there is the host's to handle.
      detached: true,
    });
    const pasta = new Pasta(child);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ended: string | null = null;
    void pasta.ended.then((reason) => {
      ended = reason;
    });
    while (!configured(pid)) {
      if (ended !== null) throw new Error(ended);
      if (Date.now() > deadline) {
        pasta.kill();
        throw new Error(`pasta did not configure the namespace within ${READY_TIMEOUT_MS} ms`);
      }
      await Bun.sleep(POLL_MS);
    }
    return pasta;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill(), STOP_GRACE_MS);
    await this.ended;
    clearTimeout(timer);
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
