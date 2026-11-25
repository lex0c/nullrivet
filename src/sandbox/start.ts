import { errorMessage } from '../errors.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import { createJobTools, type JobSession } from '../tools/jobs.ts';
import type { SandboxProfile, SandboxScope } from '../tools/policy.ts';
import {
  atLeast,
  inspectLaunch,
  type LaunchOptions,
  OVERLAY_BWRAP_VERSION,
  sandboxHost,
  sandboxProject,
  workspaceLaunch,
} from './bwrap.ts';
import { WorkerBackend } from './worker-backend.ts';
import {
  createWorkspaceDirectory,
  projectFilesystemError,
  referenceTime,
  removeWorkspaceDirectory,
  type WorkspaceDirectory,
} from './workspace.ts';

// What a workspace session needs to read and apply the sandbox's changes once its worker stops.
export interface StartedWorkspace {
  directory: WorkspaceDirectory;
  // The project's real path, the lower layer of the overlay.
  root: string;
  // Changes to the project at or after this time, in nanoseconds, are the host's.
  since: bigint;
}

export interface StartedSandbox {
  backend: WorkerBackend;
  scope: SandboxScope;
  // The working directory with its symbolic links resolved: the sandbox exposes the project at
  // its real path only.
  cwd: string;
  workspace?: StartedWorkspace;
  warnings: string[];
}

// Removes the directory of a workspace that did not start. The sandbox can still be ending, with
// the overlay mounted, so a failure leaves it to the exit handler, after the sandbox's processes
// are killed, and to the next session; the reason the sandbox did not start is what is reported.
const discardDirectory = (directory: WorkspaceDirectory): void => {
  try {
    removeWorkspaceDirectory(directory);
  } catch {
    // Still listed as live.
  }
};

// Starts the sandbox of a session, or says why it cannot start. There is no fallback: a session
// that asked for a sandbox does not run its tools without one.
export const startSandbox = async (
  profile: SandboxProfile,
  cwd: string,
  env: Record<string, string | undefined>,
  readOnlyDirs: readonly string[],
  jobs: JobSession,
): Promise<StartedSandbox | { error: string }> => {
  const host = sandboxHost();
  if (typeof host === 'string') return { error: host };
  const project = await sandboxProject(cwd, env);
  if ('error' in project) return project;
  // The job tools run in the worker too, with the registry their jobs live in.
  const tools = [...BUILTIN_TOOLS, ...createJobTools(null, jobs)].map((tool) => tool.name);
  const options: LaunchOptions = {
    host,
    root: project.root,
    cwd: project.cwd,
    home: project.home,
    hostEnv: env,
    tools,
    readOnlyDirs,
    jobs,
  };
  let workspace: StartedWorkspace | undefined;
  const warnings: string[] = [];
  if (profile === 'workspace') {
    if (!atLeast(host.version, OVERLAY_BWRAP_VERSION)) {
      return {
        error: `the workspace sandbox needs Bubblewrap ${OVERLAY_BWRAP_VERSION.join('.')} or later; ${host.bwrap} is version ${host.version.join('.')}`,
      };
    }
    let created: ReturnType<typeof createWorkspaceDirectory>;
    try {
      const filesystem = projectFilesystemError(project.root);
      if (filesystem !== null) return { error: filesystem };
      created = createWorkspaceDirectory(env);
    } catch (error) {
      return { error: `the workspace sandbox cannot be prepared: ${errorMessage(error)}` };
    }
    if ('error' in created) return created;
    warnings.push(...created.warnings);
    try {
      // Taken before the overlay is mounted: nothing the sandbox does can come before it.
      const since = referenceTime(created.directory, project.root);
      workspace = { directory: created.directory, root: project.root, since };
    } catch (error) {
      discardDirectory(created.directory);
      return { error: `the workspace sandbox cannot be prepared: ${errorMessage(error)}` };
    }
  }
  try {
    const backend = await WorkerBackend.start({
      launch:
        workspace === undefined
          ? inspectLaunch(options)
          : workspaceLaunch(options, workspace.directory),
      tools,
      jobs: true,
    });
    return {
      backend,
      scope: { profile, root: project.root },
      cwd: project.cwd,
      ...(workspace === undefined ? {} : { workspace }),
      warnings,
    };
  } catch (error) {
    if (workspace !== undefined) discardDirectory(workspace.directory);
    return { error: `the ${profile} sandbox did not start: ${errorMessage(error)}` };
  }
};
