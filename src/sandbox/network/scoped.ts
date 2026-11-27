import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cgroupLimits, type Limits, missingLimits } from '../limits.ts';

// A helper of the network in a scope of the user's service manager of its own, so that what it
// does for the sandbox costs it what its own limits allow, and its end can be confirmed whole.
export interface HelperScope {
  // What starts the helper in the scope, named `unit`.
  prefix: readonly string[];
  // For that command alone.
  env: Record<string, string>;
  unit: string;
  limits: Limits;
}

const POLL_MS = 20;
const EMPTIED_TIMEOUT_MS = 5_000;

// The cgroup of the unit named, found through any process in it: when what started the helper did
// not run it in place, the helper runs there without being the process followed.
export const unitCgroup = (unit: string): string | null => {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const path = cgroupOf(Number(entry));
    if (path?.endsWith(`/${unit}`) === true) return path;
  }
  return null;
};

// The cgroup `pid` runs in, or null once it is gone.
export const cgroupOf = (pid: number): string | null => {
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
export const emptied = async (path: string, what: string): Promise<void> => {
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
      throw new Error(`the scope of ${what}, ${path}, still holds processes`);
    }
    await Bun.sleep(POLL_MS);
  }
};

// The process followed is the helper itself, `names` matching its command name, in the scope
// named, which holds the limits asked for: otherwise the helper would be unfollowed, or
// unlimited. Gives the scope's cgroup.
export const confirmScope = (
  pid: number,
  scope: HelperScope,
  what: string,
  names: RegExp,
): string => {
  const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  if (!names.test(comm)) throw new Error(`the process followed runs ${comm}, not ${what}`);
  const path = cgroupOf(pid);
  if (path === null || !path.endsWith(`/${scope.unit}`)) {
    throw new Error(`${what} does not run in the scope ${scope.unit}`);
  }
  const wrong = missingLimits(cgroupLimits(path), scope.limits);
  if (wrong.length > 0) {
    throw new Error(`the scope of ${what} does not hold its limits: ${wrong.join('; ')}`);
  }
  return path;
};
