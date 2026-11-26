import { errorMessage } from '../errors.ts';
import { type ApplyOutcome, applyChanges } from '../sandbox/changeset/apply.ts';
import { type Change, classify } from '../sandbox/changeset/classify.ts';
import { close, openDirectory } from '../sandbox/changeset/dirfd.ts';
import { DEFAULT_SNAPSHOT_LIMITS, readUpper } from '../sandbox/changeset/snapshot.ts';
import {
  type ApplyReport,
  applyReport,
  type ChangeEntry,
  describeChanges,
} from '../sandbox/changeset/summary.ts';
import { symlinkTargetsInside } from '../sandbox/changeset/validate.ts';
import type { StartedWorkspace } from '../sandbox/start.ts';
import { EXIT_CODES } from './exit-codes.ts';

export type ChangesEvent =
  | { type: 'changes:preview'; changes: ChangeEntry[] }
  | {
      type: 'changes:discarded';
      // `interrupted`: the task finished, and the operator interrupted the run before the changes
      // were applied.
      reason: 'not-requested' | 'task-not-done' | 'interrupted';
      count: number;
    }
  | ({ type: 'changes:applied' } & ApplyReport)
  | { type: 'changes:failed'; message: string };

export const WORKSPACE_EXIT_CODES = {
  // The task finished, and some or all of its changes were not applied: conflicts, refusals, or
  // changes that could not be read, when none is applied. The project holds those reported as
  // applied.
  notApplied: 4,
  // The application stopped part-way: the project holds the changes before the stop only.
  stopped: 5,
};

const GIT = Buffer.from('.git');

// Git commands in the sandbox change the project's own .git, which is never applied: its refusal
// alone is no failure. A .git deeper in the project belongs to a repository the task made or
// changed, whose files would reach the project without it.
const projectGit = (change: Change): boolean =>
  change.op === 'refuse' && change.path.length === 1 && GIT.equals(change.path[0] as Buffer);

// The exit code of a task whose changes were applied.
export const appliedExitCode = (outcome: ApplyOutcome): number => {
  if (outcome.stopped !== null) return WORKSPACE_EXIT_CODES.stopped;
  const missed =
    outcome.conflicts.length > 0 || outcome.refused.some(({ change }) => !projectGit(change));
  return missed ? WORKSPACE_EXIT_CODES.notApplied : 0;
};

export interface ReadChanges {
  changes: Change[];
  entries: ChangeEntry[];
}

// What the sandbox changed in the project open at `root`, checked and described. `live` reads it
// while the worker runs, for a preview: what the worker writes meanwhile can be missing or half
// written, so only a reading once it has stopped is applied.
export const readChanges = (
  workspace: StartedWorkspace,
  root: number,
  live = false,
): ReadChanges => {
  const upper = workspace.directory.upper;
  const snapshot = readUpper(upper, DEFAULT_SNAPSHOT_LIMITS, live);
  const changes = symlinkTargetsInside(classify(snapshot, root), snapshot, root, workspace.root);
  return { changes, entries: describeChanges(changes, root, upper) };
};

export interface FinishOptions {
  // The operator's authorization, given before the task ran, to apply its changes if it finishes.
  apply: boolean;
  done: boolean;
  // The operator interrupted the run after the task finished, before the changes were applied.
  interrupted: boolean;
  // The exit code of the task itself.
  code: number;
  report: (event: ChangesEvent) => void;
}

// Reads what the sandbox changed, once its worker has stopped, shows it, and applies it when the
// operator asked for it and the task finished; otherwise the changes are discarded with the
// sandbox. Returns the exit code.
export const finishWorkspace = (workspace: StartedWorkspace, options: FinishOptions): number => {
  const applying = options.apply && options.done && !options.interrupted;
  // Discarding is still what happens, but the run did not show what the task changed: a task that
  // finished does not end with success.
  const unread = (error: unknown): number => {
    options.report({
      type: 'changes:failed',
      message: `the changes of the sandbox could not be read, and none is applied: ${errorMessage(error)}`,
    });
    if (applying) return WORKSPACE_EXIT_CODES.notApplied;
    return options.code === EXIT_CODES.done ? EXIT_CODES.error : options.code;
  };
  let root: number;
  try {
    root = openDirectory(workspace.root);
  } catch (error) {
    return unread(error);
  }
  try {
    let changes: Change[];
    let entries: ChangeEntry[];
    try {
      ({ changes, entries } = readChanges(workspace, root));
    } catch (error) {
      return unread(error);
    }
    options.report({ type: 'changes:preview', changes: entries });
    if (!applying) {
      options.report({
        type: 'changes:discarded',
        reason: !options.apply ? 'not-requested' : options.done ? 'interrupted' : 'task-not-done',
        count: entries.length,
      });
      return options.code;
    }
    let outcome: ApplyOutcome;
    try {
      outcome = applyChanges(changes, {
        projectRoot: root,
        projectPath: workspace.root,
        upperPath: workspace.directory.upper,
        since: workspace.since,
      });
    } catch (error) {
      // Each change is applied whole or not at all, but which ones were is not known here.
      options.report({
        type: 'changes:failed',
        message: `applying the changes failed, and the project may hold some of them: ${errorMessage(error)}`,
      });
      return WORKSPACE_EXIT_CODES.stopped;
    }
    options.report({ type: 'changes:applied', ...applyReport(outcome) });
    return appliedExitCode(outcome);
  } finally {
    close(root);
  }
};
