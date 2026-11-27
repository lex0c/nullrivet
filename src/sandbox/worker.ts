import { dlopen, FFIType } from 'bun:ffi';
import { createReadStream, createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import { thrownToolError } from '../agent/tool-broker.ts';
import { errorMessage } from '../errors.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import { createJobTools, JobRegistry } from '../tools/jobs.ts';
import { jobLogs, outputFiles, removeOutputFiles } from '../tools/output-files.ts';
import { killAllProcessGroups } from '../tools/process.ts';
import { type Tool, type ToolResult, toolError } from '../tools/types.ts';
import { LineSplitter } from './lines.ts';
import {
  encodeMessage,
  HOST_TO_WORKER_FD,
  isTouchedPath,
  MAX_LINE_BYTES,
  MAX_META_BYTES,
  MAX_TOUCHED_PATHS,
  PROTOCOL_VERSION,
  parseHostMessage,
  WORKER_TO_HOST_FD,
  type WorkerToHost,
} from './protocol.ts';

const PR_SET_DUMPABLE = 4;

// The commands the worker starts run as the same user in the same namespaces. While the worker is
// dumpable they can open its /proc entries: read its environment and descriptors, and write to the
// protocol pipe. A process that is not dumpable has those entries owned by root, out of their
// reach. Returns why that could not be done, or null.
const makeNotDumpable = (): string | null => {
  if (process.platform !== 'linux') return 'the sandbox worker runs on Linux only';
  try {
    const libc = dlopen('libc.so.6', {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      return libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) === 0
        ? null
        : 'prctl(PR_SET_DUMPABLE, 0) failed';
    } finally {
      libc.close();
    }
  } catch (error) {
    return `prctl could not be called: ${errorMessage(error)}`;
  }
};

// The host stops the sandbox on a result over the protocol's bounds, so a legitimate result is
// held to them: meta that is too large is left out, and only the first valid touched paths are
// kept, which leaves the AGENTS.md files of the others undiscovered.
const resultMessage = (id: string, result: ToolResult): string => {
  const meta =
    result.meta === undefined ||
    Buffer.byteLength(JSON.stringify(result.meta), 'utf8') > MAX_META_BYTES
      ? undefined
      : result.meta;
  const touchedPaths = result.touchedPaths?.filter(isTouchedPath).slice(0, MAX_TOUCHED_PATHS);
  const line = encodeMessage({
    type: 'tool.result',
    id,
    result: {
      content: result.content,
      isError: result.isError,
      ...(meta === undefined ? {} : { meta }),
      ...(touchedPaths === undefined ? {} : { touchedPaths }),
      // Within the protocol's bounds by construction: the tools report at most one per stream.
      ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
    },
  });
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
  // The host stops the sandbox on a longer line, so a result that large is replaced by an error.
  return encodeMessage({
    type: 'tool.result',
    id,
    result: toolError('tool.result_too_large', 'the tool result is too large to return'),
  });
};

// Runs tools for the host over the protocol descriptors until the host sends worker.shutdown or
// closes its end. The host authorizes every call; the worker only carries out the ones it is
// sent, among the tools it was started with.
export const runWorker = (argv: readonly string[]): void => {
  const out = createWriteStream('', { fd: WORKER_TO_HOST_FD });
  // Without the host there is no one to answer, so a failed write ends the worker.
  out.on('error', () => process.exit(1));
  const running = new Map<string, AbortController>();
  let stopping = false;
  // Nothing is sent once the worker stops: the stream is ending, and the host no longer listens.
  const send = (message: WorkerToHost): void => {
    if (!stopping) out.write(encodeMessage(message));
  };
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    for (const controller of running.values()) controller.abort();
    killAllProcessGroups();
    removeOutputFiles();
    out.end(() => process.exit(code));
  };
  const fail = (message: string): void => {
    send({ type: 'worker.error', message });
    stop(1);
  };

  process.on('exit', () => {
    killAllProcessGroups();
    removeOutputFiles();
  });
  // The host stops the worker over the protocol, or kills its group; it never signals it. A signal
  // comes from a command in the sandbox, which runs as the same user and can see the worker, such
  // as `pkill bun` meant for a dev server: it must not end the session's tools. SIGKILL cannot be
  // ignored, and still loses the sandbox.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(signal, () => undefined);
  }

  const dumpable = makeNotDumpable();
  if (dumpable !== null) {
    fail(dumpable);
    return;
  }
  let toolNames: string[];
  let jobSession: string | undefined;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        tools: { type: 'string' },
        jobs: { type: 'string' },
        'hash-outputs': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    toolNames = (values.tools ?? '').split(',').filter((name) => name.length > 0);
    jobSession = values.jobs;
    // For the evidence log: what each command writes is hashed as it comes.
    if (values['hash-outputs'] === true) {
      outputFiles.hashOutputs();
      jobLogs.hashOutputs();
    }
  } catch (error) {
    fail(`invalid worker arguments: ${errorMessage(error)}`);
    return;
  }
  const available = new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  let registry: JobRegistry | null = null;
  if (jobSession !== undefined) {
    if (jobSession !== 'interactive' && jobSession !== 'one-shot') {
      fail(`the worker has no job session named ${jobSession}`);
      return;
    }
    // The jobs live here; the host learns each fact as it happens, in order, on the same
    // descriptor as the results: a job's start before the result of the call that started it,
    // and its events before whatever they let resume.
    let seq = 0;
    registry = new JobRegistry(jobLogs, {
      started: (jobId, callId) =>
        send({ type: 'job.started', jobId, ...(callId === undefined ? {} : { callId }) }),
      occurred: (event) => {
        seq += 1;
        send({ type: 'job.event', seq, event });
      },
      shown: (jobId) => send({ type: 'job.shown', jobId }),
    });
    for (const tool of createJobTools(registry, jobSession)) available.set(tool.name, tool);
  }
  const tools = new Map<string, Tool>();
  for (const name of toolNames) {
    const tool = available.get(name);
    if (tool === undefined) {
      fail(`the worker has no tool named ${name}`);
      return;
    }
    tools.set(name, tool);
  }

  // The calls under way that can start a job, which a stop of the jobs waits for: the job they
  // start is listed only once it runs.
  const starting = new Set<Promise<void>>();
  const execute = async (
    id: string,
    name: string,
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<void> => {
    const controller = new AbortController();
    running.set(id, controller);
    const tool = tools.get(name);
    let result: ToolResult;
    if (tool === undefined) {
      result = toolError('tool.unknown', `the sandbox does not run ${name}`);
    } else {
      try {
        result = await tool.execute(input, { cwd, signal: controller.signal, callId: id });
      } catch (error) {
        result = thrownToolError(name, error);
      }
    }
    running.delete(id);
    if (!stopping) out.write(resultMessage(id, result));
  };

  // Ends every job that runs, each within the registry's wait, and says how many did not end.
  // Ends every job, those that calls received before the stop are still starting included, and says
  // how many did not end.
  const stopJobs = async (): Promise<void> => {
    await Promise.all(starting);
    const jobs = registry?.list().filter((job) => job.finish === null) ?? [];
    const ended = await Promise.all(jobs.map((job) => (registry as JobRegistry).kill(job)));
    send({ type: 'jobs.stopped', running: ended.filter((done) => !done).length });
  };
  const splitter = new LineSplitter(
    MAX_LINE_BYTES,
    (line) => {
      // A chunk can hold more lines after the one that stopped the worker; none of them starts a
      // call.
      if (stopping) return;
      const message = parseHostMessage(line);
      if (message === null) {
        fail('the host sent a malformed message');
        return;
      }
      switch (message.type) {
        case 'tool.execute': {
          if (running.has(message.id)) {
            fail(`the host reused the call id ${message.id}`);
            return;
          }
          const call = execute(message.id, message.name, message.input, message.cwd);
          if (message.name === 'bash_background') {
            starting.add(call);
            void call.finally(() => starting.delete(call));
          }
          return;
        }
        case 'tool.cancel':
          running.get(message.id)?.abort();
          return;
        case 'jobs.stop':
          void stopJobs();
          return;
        case 'worker.shutdown':
          stop(0);
          return;
        case 'worker.environment':
          Object.assign(process.env, message.variables);
          return;
      }
    },
    () => fail('a host message exceeds the line limit'),
  );
  const input = createReadStream('', { fd: HOST_TO_WORKER_FD });
  input.on('data', (chunk) => splitter.push(chunk as Buffer));
  input.on('end', () => stop(0));
  input.on('error', () => stop(1));

  send({ type: 'worker.ready', protocol: PROTOCOL_VERSION, tools: [...tools.keys()] });
};
