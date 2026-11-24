import { errorMessage } from '../errors.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import type { SandboxProfile, SandboxScope } from '../tools/policy.ts';
import { inspectLaunch, sandboxHost, sandboxProject } from './bwrap.ts';
import { WorkerBackend } from './worker-backend.ts';

export interface StartedSandbox {
  backend: WorkerBackend;
  scope: SandboxScope;
  // The working directory with its symbolic links resolved: the sandbox exposes the project at
  // its real path only.
  cwd: string;
}

// Starts the sandbox of a session, or says why it cannot start. There is no fallback: a session
// that asked for a sandbox does not run its tools without one.
export const startSandbox = async (
  profile: SandboxProfile,
  cwd: string,
  env: Record<string, string | undefined>,
  readOnlyDirs: readonly string[],
): Promise<StartedSandbox | { error: string }> => {
  const host = sandboxHost(env);
  if (typeof host === 'string') return { error: host };
  const project = await sandboxProject(cwd, env);
  if ('error' in project) return project;
  const tools = BUILTIN_TOOLS.map((tool) => tool.name);
  try {
    const backend = await WorkerBackend.start({
      launch: inspectLaunch({
        host,
        root: project.root,
        cwd: project.cwd,
        home: project.home,
        hostEnv: env,
        tools,
        readOnlyDirs,
      }),
      tools,
    });
    return { backend, scope: { profile, root: project.root }, cwd: project.cwd };
  } catch (error) {
    return { error: `the ${profile} sandbox did not start: ${errorMessage(error)}` };
  }
};
