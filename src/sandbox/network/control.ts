import { readlinkSync } from 'node:fs';
import { type NetworkTools, runInNamespaces } from './namespace.ts';
import { Pasta, type PastaAddress } from './pasta.ts';
import { NOTHING, rulesetFor, type Scope, TABLE } from './ruleset.ts';

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

  // Replaces the ruleset with `scope`'s, in one transaction, and checks it.
  async replace(scope: Scope): Promise<void> {
    if (this.closed) throw new Error('the network was closed');
    await install(this.tools, this.pid, scope);
  }

  // Closes the network: the ruleset that authorizes nothing first, then pasta. Idempotent.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await install(this.tools, this.pid, NOTHING);
    } catch {
      // The namespace is gone, or its ruleset cannot be changed: pasta ends next either way.
    }
    await this.pasta.stop();
  }
}

// Installs `scope`'s ruleset in the namespaces of `pid`, and checks that the kernel holds the
// table, alone, with both chains dropping by default.
const install = async (tools: NetworkTools, pid: number, scope: Scope): Promise<void> => {
  await runInNamespaces(tools, pid, [tools.nft, '-f', '-'], rulesetFor(scope));
  const held = await runInNamespaces(tools, pid, [tools.nft, 'list', 'ruleset']);
  const tables = held.split('\n').filter((line) => line.startsWith('table '));
  const drops = held.split('\n').filter((line) => line.includes('policy drop;'));
  if (tables.length !== 1 || tables[0] !== `table inet ${TABLE} {` || drops.length !== 2) {
    throw new Error('the ruleset the namespace holds is not the one installed');
  }
};
