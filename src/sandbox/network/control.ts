import { readlinkSync } from 'node:fs';
import { type NetworkTools, runInNamespaces } from './namespace.ts';
import { Pasta, type PastaAddress } from './pasta.ts';
import { buildRuleset, NOTHING, type Ruleset, type Scope, TABLE } from './ruleset.ts';

// The network of a sandbox whose worker waits to be released, as Bubblewrap's --block-fd makes it.
// The steps are ordered so that no packet leaves the namespace before the scope's ruleset holds:
//
//   1. a ruleset that authorizes nothing, while the namespace still has only its loopback;
//   2. the ping group range, so ICMP echo works without raw sockets;
//   3. pasta, which gives the namespace its way out, still closed by that ruleset;
//   4. the scope's ruleset, in one transaction, then checked as the kernel holds it.
//
// Only then may the caller release the worker; a step that fails rejects, and the caller ends the
// sandbox without releasing it. Revoking installs the ruleset that authorizes nothing before
// anything else ends, and a pasta that ends leaves the namespace closed: nothing starts it again.

export interface NetworkOptions {
  // For a namespace that must reach the host's own address, as tests do.
  address?: PastaAddress;
}

const GROUP_RANGE = '/proc/sys/net/ipv4/ping_group_range';

export class NetworkControl {
  private failed: string | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  // The installations, one after another: two transactions are each atomic, but not ordered, and a
  // ruleset installed after a revocation would undo it.
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly tools: NetworkTools,
    private readonly pid: number,
    private readonly pasta: Pasta,
  ) {
    void pasta.ended.then((reason) => {
      if (!this.closed) this.failed = reason;
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

  // Why the network stopped working, such as pasta ending; null while it works.
  failure(): string | null {
    return this.failed;
  }

  // Replaces the ruleset with `scope`'s, in one transaction, and checks it, after the
  // installations before it. One whose turn comes after the network was closed installs nothing.
  replace(scope: Scope): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the network was closed'));
    return this.serial(async () => {
      if (this.closed) throw new Error('the network was closed');
      await install(this.tools, this.pid, scope);
    });
  }

  // Closes the network for good: the ruleset that authorizes nothing, then pasta ends. It is
  // installed at once, without waiting for an installation under way, whose helper may hang until
  // its timeout, and again once that one is done, since its ruleset may land after the first.
  // Installations still waiting install nothing. Idempotent.
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closed = true;
    const nothing = () =>
      install(this.tools, this.pid, NOTHING).catch(() => {
        // The namespace is gone, or its ruleset cannot be changed: pasta ends next either way.
      });
    this.closing = (async () => {
      await nothing();
      await this.serial(nothing);
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

// What `nft -j list ruleset` lists, as far as the check reads it.
interface Listed {
  table?: { family?: string; name?: string };
  chain?: { table?: string; name?: string; hook?: string; type?: string; policy?: string };
  set?: { table?: string; name?: string };
  rule?: { table?: string; chain?: string };
}

// Installs `scope`'s ruleset in the namespaces of `pid`, then checks what the kernel holds against
// what was written: its one table, the chains with their hooks and policies, the sets of the rate
// limit, and as many rules in each chain as were written. The transaction applies whole or not at
// all; this finds a namespace that holds something else.
const install = async (tools: NetworkTools, pid: number, scope: Scope): Promise<void> => {
  const ruleset = buildRuleset(scope);
  await runInNamespaces(tools, pid, [tools.nft, '-f', '-'], ruleset.text);
  const listed = await runInNamespaces(tools, pid, [tools.nft, '-j', 'list', 'ruleset']);
  const problem = rulesetProblem(listed, ruleset);
  if (problem !== null)
    throw new Error(`the namespace does not hold the ruleset installed: ${problem}`);
};

export const rulesetProblem = (listed: string, ruleset: Ruleset): string | null => {
  let items: Listed[];
  try {
    const parsed = JSON.parse(listed) as { nftables?: unknown };
    if (!Array.isArray(parsed.nftables)) return 'nft listed no ruleset';
    items = parsed.nftables as Listed[];
  } catch {
    return 'nft listed something other than JSON';
  }
  const tables = items.flatMap((item) => (item.table === undefined ? [] : [item.table]));
  if (tables.length !== 1 || tables[0]?.family !== 'inet' || tables[0].name !== TABLE) {
    return `${tables.length} tables instead of inet ${TABLE}`;
  }
  const chains = new Map(
    items.flatMap((item) => (item.chain === undefined ? [] : [[item.chain.name, item.chain]])),
  );
  const expectations: [string, string | undefined, string | undefined][] = [
    ['output', 'output', 'drop'],
    ['input', 'input', 'drop'],
    ['refuse', undefined, undefined],
  ];
  if (chains.size !== expectations.length) return `${chains.size} chains instead of 3`;
  for (const [name, hook, policy] of expectations) {
    const chain = chains.get(name);
    if (chain === undefined) return `no chain ${name}`;
    if (chain.hook !== hook || chain.policy !== policy)
      return `chain ${name} has another hook or policy`;
  }
  const sets = items.flatMap((item) => (item.set === undefined ? [] : [item.set.name])).sort();
  if (sets.join(',') !== 'new4,new6') return `sets ${sets.join(', ')} instead of new4, new6`;
  for (const [chain, count] of Object.entries(ruleset.rules)) {
    const held = items.filter((item) => item.rule?.chain === chain).length;
    if (held !== count) return `chain ${chain} holds ${held} rules instead of ${count}`;
  }
  return null;
};
