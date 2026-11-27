import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { HELPER_ENV, inNewNamespaces, type NetworkTools, runInNamespaces } from './namespace.ts';
import { Pasta, type PastaAddress } from './pasta.ts';
import { CLOSED_RULESET, NOTHING, rulesetFor, type Scope } from './ruleset.ts';

// A ruleset goes to nft as its one argument, which it applies as one transaction, as it does a file:
// nftables 1.0.9, as on Ubuntu 24.04, cannot read a script from a pipe.
//
// The network of a sandbox whose worker waits to be released, as Bubblewrap's --block-fd makes it.
// The steps are ordered so that no packet leaves the namespace before the scope's ruleset holds:
//
//   1. a ruleset that authorizes nothing, while the namespace still has only its loopback;
//   2. the ping group range, so ICMP echo works without raw sockets;
//   3. pasta, which gives the namespace its way out, still closed by that ruleset;
//   4. the scope's ruleset, in one transaction, then checked as the kernel holds it.
//
// Only then may the caller release the worker; a step that fails rejects, and the caller ends the
// sandbox without releasing it.
//
// The scope's installations run one after another: two transactions are each atomic, but not
// ordered. Revoking does not take its turn among them: it adds, at once, a table of its own that
// stops everything, which no installation of a scope touches, so no installation under way can
// authorize anything again once it is there, even for an instant. An installation that fails, or
// that the kernel does not hold as written, revokes the network: a scope that was not confirmed
// never stays. A pasta that ends leaves the namespace closed: nothing starts it again.

export interface NetworkOptions {
  // For a namespace that must reach the host's own address, as tests do.
  address?: PastaAddress;
}

const GROUP_RANGE = '/proc/sys/net/ipv4/ping_group_range';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class NetworkControl {
  private failed: string | null = null;
  private revoked: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly tools: NetworkTools,
    private readonly pid: number,
    private readonly pasta: Pasta,
  ) {
    void pasta.ended.then((reason) => {
      if (this.revoked === null) this.failed = reason;
    });
  }

  // Prepares the network of the namespaces of `pid` for `scope`.
  static async prepare(
    tools: NetworkTools,
    pid: number,
    scope: Scope,
    options: NetworkOptions = {},
  ): Promise<NetworkControl> {
    // Until the process has made them, its namespaces are the host's.
    for (const kind of ['user', 'net']) {
      if (readlinkSync(`/proc/${pid}/ns/${kind}`) === readlinkSync(`/proc/self/ns/${kind}`)) {
        throw new Error(`process ${pid} runs in the host's ${kind} namespace`);
      }
    }
    await install(tools, pid, NOTHING);
    // Every group of the namespace, which maps only the user's: its processes may open ICMP echo
    // sockets. The range is read in the namespace's ids.
    await runInNamespaces(tools, pid, [tools.sh, '-c', `printf '0 0' > ${GROUP_RANGE}`]);
    const pasta = await Pasta.start(tools, pid, options.address);
    const control = new NetworkControl(tools, pid, pasta);
    try {
      await control.replace(scope);
    } catch (error) {
      await control.close();
      throw error;
    }
    return control;
  }

  // Why the network stopped working, such as pasta ending or a scope that could not be installed;
  // null while it works.
  failure(): string | null {
    return this.failed;
  }

  // Replaces the ruleset with `scope`'s, in one transaction, and checks it, after the
  // installations before it. Refused once the network is revoked. One that fails revokes it.
  replace(scope: Scope): Promise<void> {
    if (this.revoked !== null) return Promise.reject(new Error('the network was revoked'));
    return this.serial(async () => {
      if (this.revoked !== null) throw new Error('the network was revoked');
      try {
        await install(this.tools, this.pid, scope);
      } catch (error) {
        if (this.revoked !== null) throw new Error('the network was revoked');
        this.failed = `the scope could not be installed: ${message(error)}`;
        await this.revoke();
        throw error;
      }
    });
  }

  // Closes the network for good, at once: the table that stops everything goes in, ahead of the
  // scope's, whatever installation is under way. Should that fail, pasta ends, which leaves the
  // namespace without a way out. The sandbox stays, and its files can still be read. Idempotent.
  revoke(): Promise<void> {
    this.revoked ??= (async () => {
      try {
        await runInNamespaces(this.tools, this.pid, [this.tools.nft, CLOSED_RULESET]);
      } catch (error) {
        this.failed ??= `the network could not be revoked: ${message(error)}`;
        await this.pasta.stop();
      }
    })();
    return this.revoked;
  }

  // Revokes the network, then ends pasta. Idempotent.
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.revoke();
      await this.pasta.stop();
    })();
    return this.closing;
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// What `nft -j list ruleset` lists, without what differs between two namespaces holding the same
// ruleset: the version information and the handles.
export const normalizedListing = (listed: string): string => {
  const parsed = JSON.parse(listed) as { nftables?: unknown[] };
  if (!Array.isArray(parsed.nftables)) throw new Error('nft listed no ruleset');
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'handle')
        .map(([key, inner]) => [key, strip(inner)]),
    );
  };
  return JSON.stringify(
    parsed.nftables
      .filter((item) => !(typeof item === 'object' && item !== null && 'metainfo' in item))
      .map(strip),
  );
};

// What a namespace that holds nothing else lists once `text` is installed in it: the same text as
// nft parses it and the kernel holds it, to compare with.
const reference = (tools: NetworkTools, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = inNewNamespaces(tools, [
      tools.sh,
      '-c',
      `${tools.nft} "$1" && ${tools.nft} -j list ruleset`,
      'sh',
      text,
    ]);
    const child = spawn(file as string, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: HELPER_ENV,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`the reference ruleset could not be made: ${stderr.trim()}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end();
  });

// Installs `scope`'s ruleset in the namespaces of `pid`, in one transaction, then checks that the
// kernel holds exactly what was written, as a namespace that holds nothing else does once the
// same text is installed in it: every table, chain, set and rule, as nft lists them.
const install = async (tools: NetworkTools, pid: number, scope: Scope): Promise<void> => {
  const text = rulesetFor(scope);
  await runInNamespaces(tools, pid, [tools.nft, text]);
  const [held, expected] = await Promise.all([
    runInNamespaces(tools, pid, [tools.nft, '-j', 'list', 'ruleset']),
    reference(tools, text),
  ]);
  if (normalizedListing(held) !== normalizedListing(expected)) {
    throw new Error('the namespace does not hold the ruleset installed');
  }
};
