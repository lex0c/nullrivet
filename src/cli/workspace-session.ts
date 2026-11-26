import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { RuntimeNotice } from '../agent/loop.ts';
import { errorMessage } from '../errors.ts';
import { applyChanges, changeKey } from '../sandbox/changeset/apply.ts';
import type { Change } from '../sandbox/changeset/classify.ts';
import { close, openDirectory } from '../sandbox/changeset/dirfd.ts';
import { type ApplyReport, applyReport, type ChangeEntry } from '../sandbox/changeset/summary.ts';
import type { SandboxSession } from '../sandbox/session.ts';
import type { StartedWorkspace } from '../sandbox/start.ts';
import { isWithinDirectory } from '../tools/paths.ts';
import { readChanges } from './workspace-changes.ts';

// What the sandbox of an interactive workspace session changed, as shown to the operator, and
// what applying or discarding it does. Both stop the sandbox and start a new one on the project as
// it is then; the model is told what became of its changes, since they no longer show in the new
// sandbox unless they were applied.

export interface Preview {
  entries: ChangeEntry[];
  // The changes shown, by changeKey: applying takes these only.
  shown: ReadonlySet<string>;
  // Entries that applying would change in the project: refusals, such as .git, are never applied.
  pending: number;
}

export interface Applied {
  // Null when the changes could not be read once the sandbox stopped, and none was applied.
  report: ApplyReport | null;
  // An AGENTS.md file of the project may have changed: one was written or removed, a file one
  // links to was changed, or a directory that could hold one was removed or replaced.
  instructionsChanged: boolean;
  failure: string | null;
  // Why no sandbox runs after the application, or null when a new one started.
  stopped: string | null;
  warnings: string[];
}

export interface Discarded {
  stopped: string | null;
  warnings: string[];
}

// Why the session cannot be saved to `path`, an existing directory's entry, while the workspace
// sandbox of the project at `root` runs, or null. A session file saved into the project would
// change the overlay's lower layer while it is mounted, and conflict with the sandbox's changes
// beside it.
export const sessionFileError = async (path: string, root: string): Promise<string | null> => {
  const real = join(await realpath(dirname(path)), basename(path));
  return isWithinDirectory(root, real)
    ? `the session file ${real} is in the project, which the workspace sandbox does not change while it runs; save it outside the project`
    : null;
};

// A short random code the operator types to confirm: nothing typed before the question was asked
// can hold it.
export const confirmationCode = (): string => randomBytes(2).toString('hex').toUpperCase();

// Paths named in a note to the model, at most: a task can change thousands of files.
const NOTE_PATHS = 100;

const pathList = (lines: readonly string[]): string =>
  [
    ...lines.slice(0, NOTE_PATHS),
    ...(lines.length > NOTE_PATHS ? [`... and ${lines.length - NOTE_PATHS} more`] : []),
  ].join('\n');

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const RESTART_NOTE = (stopped: string | null): string =>
  stopped === null
    ? 'A new sandbox runs on the project as it is now; background jobs of the earlier one were stopped.'
    : 'The sandbox did not restart: no tool can run for the rest of the session.';

export class WorkspaceSession {
  constructor(
    // The project's real path, which the paths of the changes are relative to.
    readonly root: string,
    private readonly sandbox: SandboxSession,
    private readonly notify: (notice: RuntimeNotice) => void,
    // The real paths of the AGENTS.md files the agent loaded, which can be links to other files.
    private readonly instructionFiles: () => readonly string[] = () => [],
  ) {}

  // Whether the sandbox is being stopped and replaced, for an application or a discard.
  get busy(): boolean {
    return this.sandbox.busy;
  }

  // Whether a sandbox's changes are left: none once a new sandbox did not start.
  get active(): boolean {
    return this.sandbox.workspace !== null;
  }

  // Why the session's tools stopped, or null while they run.
  failure(): string | null {
    return this.sandbox.failure();
  }

  runningJobs(): number {
    return this.sandbox.jobs.running();
  }

  // The changes as they are now, read while the sandbox runs.
  preview(): Preview | { error: string } {
    const workspace = this.sandbox.workspace;
    if (workspace === null) {
      return { error: `no sandbox runs: ${this.sandbox.failure() ?? 'it stopped'}` };
    }
    let root: number;
    try {
      root = openDirectory(workspace.root);
    } catch (error) {
      return { error: `the project cannot be opened: ${errorMessage(error)}` };
    }
    try {
      const { changes, entries } = readChanges(workspace, root, true);
      return {
        entries,
        shown: new Set(changes.map(changeKey)),
        pending: entries.filter((entry) => entry.change !== 'refused').length,
      };
    } catch (error) {
      return { error: `the changes of the sandbox cannot be read: ${errorMessage(error)}` };
    } finally {
      close(root);
    }
  }

  // Stops the sandbox, reads its changes again and applies those that are as `preview` showed
  // them; the rest are discarded with the sandbox. `last`: the session ends, and no sandbox starts
  // again.
  async apply(preview: Preview, last = false): Promise<Applied> {
    const cycle = await this.sandbox.cycle(
      (workspace) => applyShown(workspace, preview.shown, this.instructionFiles()),
      !last,
    );
    const { report, failure, instructionsChanged } = cycle.result;
    if (report !== null) {
      const lines = [
        ...report.applied.map((path) => `applied: ${path}`),
        ...report.notApplied.map(
          (entry) =>
            `not applied (${entry.status}${entry.reason === undefined ? '' : `, ${entry.reason}`}): ${entry.path}`,
        ),
      ];
      this.notify({
        text: `The user applied the sandbox's changes to the project: ${report.applied.length} applied, ${report.notApplied.length} not applied and discarded. ${RESTART_NOTE(cycle.stopped)} The paths follow.`,
        data: pathList(lines),
      });
    } else {
      // The failure can quote names the sandbox chose: it goes as data.
      this.notify({
        text: `The user tried to apply the sandbox's changes, and it failed; what was not applied is discarded. ${RESTART_NOTE(cycle.stopped)} The failure follows.`,
        data: failure ?? '',
      });
    }
    return {
      report,
      failure,
      instructionsChanged,
      stopped: cycle.stopped,
      warnings: cycle.warnings,
    };
  }

  // Stops the sandbox and starts a new one without its changes. `preview` is null when they could
  // not be read.
  async discard(preview: Preview | null): Promise<Discarded> {
    const cycle = await this.sandbox.cycle(() => undefined);
    const discarded = (preview?.entries ?? []).filter((entry) => entry.change !== 'refused');
    this.notify(
      preview === null
        ? { text: `The user discarded the sandbox's changes. ${RESTART_NOTE(cycle.stopped)}` }
        : {
            text: `The user discarded the sandbox's changes: ${plural(discarded.length, 'entry', 'entries')}, which the project does not have. ${RESTART_NOTE(cycle.stopped)} The paths follow.`,
            data: pathList(discarded.map((entry) => `${entry.change}: ${entry.path}`)),
          },
    );
    return { stopped: cycle.stopped, warnings: cycle.warnings };
  }
}

const AGENTS_MD = Buffer.from('AGENTS.md');

const touchesInstructions = (
  changes: readonly Change[],
  root: string,
  loaded: readonly string[],
): boolean => {
  const files = new Set(loaded);
  return changes.some(
    (change) =>
      change.path.at(-1)?.equals(AGENTS_MD) === true ||
      (change.op === 'remove' && change.before === 'dir') ||
      files.has(join(root, ...change.path.map((part) => part.toString()))),
  );
};

// Applies the changes in the upper layer, read once the worker has stopped, that `shown` holds.
// Never throws: the sandbox is replaced whatever happens here.
const applyShown = (
  workspace: StartedWorkspace,
  shown: ReadonlySet<string>,
  instructionFiles: readonly string[],
): Pick<Applied, 'report' | 'failure' | 'instructionsChanged'> => {
  let root: number;
  try {
    root = openDirectory(workspace.root);
  } catch (error) {
    return {
      report: null,
      failure: `the project cannot be opened: ${errorMessage(error)}`,
      instructionsChanged: false,
    };
  }
  try {
    const { changes } = readChanges(workspace, root);
    try {
      const outcome = applyChanges(changes, {
        projectRoot: root,
        projectPath: workspace.root,
        upperPath: workspace.directory.upper,
        since: workspace.since,
        shown,
      });
      return {
        report: applyReport(outcome),
        failure: null,
        instructionsChanged: touchesInstructions(outcome.applied, workspace.root, instructionFiles),
      };
    } catch (error) {
      return {
        report: null,
        failure: `applying the changes failed, and the project may hold some of them: ${errorMessage(error)}`,
        // Which were applied is not known.
        instructionsChanged: touchesInstructions(changes, workspace.root, instructionFiles),
      };
    }
  } catch (error) {
    return {
      report: null,
      failure: `the changes of the sandbox could not be read, and none is applied: ${errorMessage(error)}`,
      instructionsChanged: false,
    };
  } finally {
    close(root);
  }
};
