import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { processStart } from '../workspace.ts';
import {
  GIVEN_UP,
  HELPER_ENV,
  inNewNamespaces,
  killHelper,
  type Namespaces,
  type NetworkTools,
  releaseNamespaces,
  runInNamespaces,
} from './namespace.ts';
import { Pasta, type PastaAddress, type PastaScope } from './pasta.ts';
import {
  closedRuleset,
  DYNAMIC_SETS,
  loopbackRuleset,
  NOTHING,
  rulesetFor,
  SCOPE_TABLES,
  type Scope,
  type ScopeTable,
} from './ruleset.ts';

// A ruleset goes to nft in a file of a directory only the user can read, which nft applies as one
// transaction: an argument is limited to 128 KiB, which a scope of many networks passes, and
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
// ordered. Closing does not take its turn among them, nor wait for a helper: pasta ends at once,
// which leaves the namespace without a way out, and a table of its own that stops everything goes
// in beside it, which no installation of a scope touches, so no installation under way can
// authorize anything again. An installation that fails, or that the kernel does not hold as
// written, closes the network: a scope that was not confirmed never stays. A pasta that ends
// leaves the namespace closed: nothing starts it again.

export interface NetworkOptions {
  // For a namespace that must reach the host's own address, as tests do.
  address?: PastaAddress;
  // A scope of its own for pasta.
  pasta?: PastaScope;
  // A port of the namespace's loopback that pasta forwards to a port of the host's, where the
  // proxy listens.
  forward?: Forward;
  // Gives up the preparation: its helpers are killed, and what it made undone.
  signal?: AbortSignal;
  // The namespace's only process of the sandbox is a virtual machine's, whose user networking
  // reaches its loopback: nothing there but the proxy's port, and nothing at all once closed.
  loopback?: 'proxy-only';
}

const GROUP_RANGE = '/proc/sys/net/ipv4/ping_group_range';

export interface Forward {
  port: number;
  to: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class NetworkControl {
  private failed: string | null = null;
  private closing: Promise<void> | null = null;
  private released: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly tools: NetworkTools,
    private readonly namespaces: Namespaces,
    private readonly pasta: Pasta,
    // The table the scope in force is in.
    private active: ScopeTable,
    private readonly proxyPort: number | undefined,
    // Tables installed once before any scope, which every installation's reference holds too.
    private readonly base: readonly string[],
  ) {
    void pasta.ended.then((reason) => {
      if (this.closing === null) this.failed = reason;
    });
  }

  // Prepares the network of the namespaces for `scope`. The control owns them from then on, and
  // releases them once closed; a preparation that fails releases them before it rejects.
  static async prepare(
    tools: NetworkTools,
    namespaces: Namespaces,
    scope: Scope,
    options: NetworkOptions = {},
  ): Promise<NetworkControl> {
    const { signal } = options;
    const base = options.loopback === 'proxy-only' ? [loopbackRuleset(options.forward?.port)] : [];
    let pasta: Pasta;
    try {
      const [first] = SCOPE_TABLES;
      // Before the first scope, with the namespace's loopback its only interface: nothing of it is
      // reached by the guest before this table holds.
      await withScripts(base, async (paths) => {
        for (const path of paths) {
          await runInNamespaces(tools, namespaces, [tools.nft, '-f', path], '', signal);
        }
      });
      await install(tools, namespaces, NOTHING, first, null, options.forward?.port, base, signal);
      // Every group of the namespace, which maps only the user's: its processes may open ICMP
      // echo sockets. The range is read in the namespace's ids.
      await runInNamespaces(
        tools,
        namespaces,
        [tools.sh, '-c', `printf '0 0' > ${GROUP_RANGE}`],
        '',
        signal,
      );
      pasta = await Pasta.start(
        tools,
        namespaces,
        options.address,
        options.pasta,
        signal,
        options.forward,
      );
    } catch (error) {
      releaseNamespaces(namespaces);
      throw error;
    }
    const control = new NetworkControl(
      tools,
      namespaces,
      pasta,
      SCOPE_TABLES[0],
      options.forward?.port,
      base,
    );
    try {
      await control.replace(scope, signal);
    } catch (error) {
      const closed = await control.dispose().then(
        () => null,
        (failure: unknown) => message(failure),
      );
      throw closed === null ? error : new Error(`${message(error)}; ${closed}`);
    }
    return control;
  }

  // Why the network stopped working, such as pasta ending or a scope that could not be installed;
  // null while it works.
  failure(): string | null {
    return this.failed;
  }

  // Replaces the ruleset with `scope`'s, in one transaction, and checks it, after the
  // installations before it. Refused once the network is closed. One that fails closes it.
  replace(scope: Scope, signal?: AbortSignal): Promise<void> {
    if (this.closing !== null) return Promise.reject(new Error('the network was closed'));
    return this.serial(async () => {
      if (this.closing !== null) throw new Error('the network was closed');
      try {
        const next = SCOPE_TABLES.find((table) => table !== this.active) as ScopeTable;
        await install(
          this.tools,
          this.namespaces,
          scope,
          next,
          this.active,
          this.proxyPort,
          this.base,
          signal,
        );
        this.active = next;
      } catch (error) {
        if (this.closing !== null) throw new Error('the network was closed');
        this.failed = `the scope could not be installed: ${message(error)}`;
        await this.close();
        throw error;
      }
    });
  }

  // Closes the network for good, at once, by two ways that wait for nothing else: pasta ends, and
  // the table that stops everything goes in, ahead of the scope's. Resolves once pasta has ended: a
  // helper that hangs installing the table holds nothing open meanwhile. The sandbox stays, and
  // its files can still be read. Idempotent.
  close(reason?: string): Promise<void> {
    // A close for a failure is one: the session tells it, as when pasta ends.
    if (reason !== undefined) this.failed ??= reason;
    if (this.closing === null) {
      const closedTable = withScripts([closedRuleset(this.base.length === 0)], ([path]) =>
        runInNamespaces(this.tools, this.namespaces, [this.tools.nft, '-f', path as string]),
      ).catch((error: unknown) => {
        this.failed ??= `the table that closes the network could not be installed: ${message(error)}`;
      });
      this.closing = this.pasta.stop();
      // The namespaces stay open until no helper can enter them any more, the closing table's
      // and an installation still running included: a descriptor closed earlier could be reused
      // for another file meanwhile.
      this.released = Promise.allSettled([closedTable, this.closing, this.queue]).then(() =>
        releaseNamespaces(this.namespaces),
      );
    }
    return this.closing;
  }

  // Closes the network, and resolves once its namespaces are released too.
  async dispose(): Promise<void> {
    await this.close();
    await this.released;
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const TMPFS = 0x01021994;

// Where the scripts go, which name the scope's targets: in memory, in the user's runtime directory
// or /dev/shm, when one is a tmpfs, so that nothing of them reaches a disk; the temporary directory
// otherwise.
const scriptRoot = (): string => {
  for (const dir of [process.env.XDG_RUNTIME_DIR, '/dev/shm']) {
    if (dir === undefined || !isAbsolute(dir)) continue;
    try {
      if (statfsSync(dir).type === TMPFS) return dir;
    } catch {
      // Missing: the next one.
    }
  }
  return tmpdir();
};

// Runs `run` with files that hold `texts`, in a directory only the user can read, removed after.
const withScripts = async <T>(
  texts: readonly string[],
  run: (paths: string[]) => Promise<T>,
): Promise<T> => {
  // Named by this process, so that the next session removes a folder it left when killed.
  const dir = mkdtempSync(
    join(scriptRoot(), `nullrivet-nft-${process.pid}-${processStart(process.pid) ?? 0}-`),
  );
  try {
    const paths = texts.map((text, index) => {
      const path = join(dir, `${index}.nft`);
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    });
    return await run(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// What `nft -j list ruleset` lists, without what differs between two namespaces holding the same
// ruleset: the version information, the handles, and the elements the rate limit's sets gained
// from the traffic, which the namespace in use has and a new one does not. The sets' types, flags,
// sizes and timeouts stay.
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
  const withoutElements = (item: unknown): unknown => {
    if (typeof item !== 'object' || item === null || !('set' in item)) return item;
    const { elem: _, ...set } = (item as { set: Record<string, unknown> }).set;
    return DYNAMIC_SETS.includes(String(set.name)) ? { set } : item;
  };
  return JSON.stringify(
    parsed.nftables
      .filter((item) => !(typeof item === 'object' && item !== null && 'metainfo' in item))
      .map(withoutElements)
      .map(strip),
  );
};

// What a namespace that holds nothing else lists once `text` is installed in it: the same text as
// nft parses it and the kernel holds it, to compare with.
const reference = (
  tools: NetworkTools,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error(GIVEN_UP));
      return;
    }
    const [file, ...args] = inNewNamespaces(tools, [
      tools.sh,
      '-c',
      `for script; do ${tools.nft} -f "$script" || exit 1; done; ${tools.nft} -j list ruleset`,
      'sh',
      ...paths,
    ]);
    // Its shell starts nft once for each transaction: the group goes whole.
    const child = spawn(file as string, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: HELPER_ENV,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString();
    });
    const timer = setTimeout(() => killHelper(child), 10_000);
    const giveUp = (): void => killHelper(child);
    signal?.addEventListener('abort', giveUp, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      reject(error);
    });
    // After its output streams closed: the exit can come before their last data.
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      if (code === 0) resolve(stdout);
      else if (signal?.aborted === true) reject(new Error(GIVEN_UP));
      else reject(new Error(`the reference ruleset could not be made: ${stderr.trim()}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end();
  });

// Installs `scope`'s ruleset into `table` in the namespaces, in its transactions, the last
// of which puts it in force in place of `previous`; then checks that the kernel holds exactly what
// was written, as a namespace that holds nothing else does once the same transactions ran in it:
// every table, chain, set and rule, as nft lists them.
// Installs `scope` into `table`, and checks the namespace holds what a new one holds with the
// `base` tables, installed before any scope, and the same transactions.
const install = async (
  tools: NetworkTools,
  namespaces: Namespaces,
  scope: Scope,
  table: ScopeTable,
  previous: ScopeTable | null,
  proxyPort: number | undefined,
  base: readonly string[],
  signal?: AbortSignal,
): Promise<void> => {
  await withScripts([...base, ...rulesetFor(scope, table, previous, proxyPort)], async (all) => {
    const paths = all.slice(base.length);
    for (const path of paths) {
      await runInNamespaces(tools, namespaces, [tools.nft, '-f', path], '', signal);
    }
    // Both settle before either fails: a helper still starting must not outlive the namespaces'
    // descriptors, which a failure releases.
    const [listed, made] = await Promise.allSettled([
      runInNamespaces(tools, namespaces, [tools.nft, '-j', 'list', 'ruleset'], '', signal),
      reference(tools, all, signal),
    ]);
    if (listed.status === 'rejected') throw listed.reason;
    if (made.status === 'rejected') throw made.reason;
    const [held, expected] = [listed.value, made.value];
    if (normalizedListing(held) !== normalizedListing(expected)) {
      throw new Error('the namespace does not hold the ruleset installed');
    }
  });
};
