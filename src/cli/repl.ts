import { homedir } from 'node:os';
import type { Agent } from '../agent/agent.ts';
import type { AgentEvent } from '../agent/events.ts';
import { errorMessage } from '../errors.ts';
import { formatTokens } from '../format.ts';
import type { ResolveResult } from '../providers/resolve.ts';
import type { SandboxProfile } from '../tools/policy.ts';
import { applyKey, type InputState, inputWithText } from '../tui/input-editor.ts';
import { createKeyParser, type KeyEvent } from '../tui/keys.ts';
import { formatPermanent } from '../tui/permanent.ts';
import { createScreen } from '../tui/screen.ts';
import {
  type Action,
  createInitialState,
  reduce,
  type StatusState,
  type TuiState,
} from '../tui/state.ts';
import {
  createFrameScheduler,
  detectCapabilities,
  disableBracketedPasteOn,
  disableModifyOtherKeys,
  disableRawMode,
  enableBracketedPasteOn,
  enableModifyOtherKeys,
  enableRawMode,
} from '../tui/term.ts';
import { composeLive } from '../tui/view.ts';
import { createAutoContinue } from './auto-continue.ts';
import type { PromptHistory } from './prompt-history.ts';
import { type SessionFile, SessionLink } from './session-file.ts';
import {
  describeModeChange,
  findCommand,
  type ParsedSlash,
  parseSlash,
  runSlash,
  type SlashContext,
  suggestCommands,
} from './slash.ts';
import type { WorkspaceSession } from './workspace-session.ts';

// A lone ESC byte is ambiguous until no continuation arrives: it is either the Escape key or the
// start of an escape sequence split across reads.
const ESC_DRAIN_MS = 30;
const EXIT_ARM_MS = 2_000;
const ANIMATION_MS = 80;

export interface ReplOptions {
  agent: Agent;
  version: string;
  cwd: string;
  resolveModel: (id: string) => Promise<ResolveResult>;
  warnings: readonly string[];
  // The session file the conversation is saved to, if any, and how many messages it brought back.
  sessionFile: SessionFile | null;
  resumedMessages: number | null;
  // Seeded from the session file, if any; the session adds what is submitted.
  history: PromptHistory;
  // Aborted when the process receives SIGINT or SIGTERM from outside the terminal.
  signal: AbortSignal;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  env: Record<string, string | undefined>;
  // The sandbox the tools run in, for the status line and the banner.
  sandbox?: SandboxProfile;
  // Set for the workspace sandbox: its changes, which the session reviews, applies and discards.
  workspace?: WorkspaceSession;
}

export const formatStats = (status: StatusState): string => {
  const t = status.totals;
  const context =
    status.contextTokens === null
      ? 'not measured yet'
      : `${formatTokens(status.contextTokens)} of ${formatTokens(status.contextWindow)} tokens (${Math.round((status.contextTokens / status.contextWindow) * 100)}%)`;
  return [
    `Model: ${status.model}`,
    `Context: ${context}`,
    `Requests: ${t.requests}`,
    `Tokens: ${formatTokens(t.input)} input, ${formatTokens(t.output)} output, ${formatTokens(t.cacheRead)} cache read, ${formatTokens(t.cacheWrite)} cache write`,
  ].join('\n');
};

const isCtrlC = (key: KeyEvent): boolean => key.kind === 'char' && key.ctrl && key.char === 'c';

const isNamedKey = (key: KeyEvent, name: string): boolean =>
  key.kind === 'key' && key.name === name;

const isShiftTab = (key: KeyEvent): boolean =>
  key.kind === 'key' && key.name === 'tab' && key.shift && !key.ctrl && !key.alt;

// Interactive session: the agent keeps its conversation between prompts until /clear or exit.
// Resolves with the process exit code.
export const runRepl = (options: ReplOptions): Promise<number> =>
  new Promise((resolveExit) => {
    const { agent, stdin, stdout } = options;
    const write = (s: string): void => {
      stdout.write(s);
    };
    let caps = detectCapabilities({ stdout, env: options.env });
    const screen = createScreen({ write, caps, resizeStream: stdout });
    let state: TuiState = createInitialState({
      model: agent.provider.id,
      mode: agent.mode,
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      effort: agent.effort,
      cwd: options.cwd,
      home: homedir(),
      contextWindow: agent.provider.capabilities.context_window,
    });
    let turn: AbortController | null = null;
    // Whether `turn` is a /compact rather than a task.
    let compacting = false;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let escTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const workspace = options.workspace;
    // The question a command waits on: the next line submitted answers it, whatever it says.
    let answering: ((answer: string | null) => void) | null = null;
    const cancelQuestion = (): void => {
      const answer = answering;
      answering = null;
      answer?.(null);
    };

    const render = (): void => {
      if (!closed) screen.render(composeLive(state, caps, Date.now()));
    };
    const scheduler = createFrameScheduler(render);

    const dispatch = (action: Action): void => {
      if (closed) return;
      const result = reduce(state, action);
      state = result.state;
      if (result.permanent.length > 0) {
        screen.print(result.permanent.flatMap((item) => formatPermanent(item, caps)));
      }
      scheduler.request();
    };

    const notice = (level: 'info' | 'warning' | 'error', text: string): void =>
      dispatch({ type: 'notice', level, text });

    // Warnings about the session file go to the interface while it is open, and to stderr once
    // the terminal has been restored (the last save happens on the way out).
    const history = options.history;
    const session = new SessionLink(
      agent,
      options.cwd,
      (message) => {
        if (closed) process.stderr.write(`nullrivet: warning: ${message}\n`);
        else notice('warning', message);
      },
      history,
    );
    if (options.sessionFile !== null) session.attach(options.sessionFile);

    const syncStatus = (): void =>
      dispatch({
        type: 'status',
        patch: {
          model: agent.provider.id,
          mode: agent.mode,
          effort: agent.effort,
          contextWindow: agent.provider.capabilities.context_window,
        },
      });

    // Keeps the footer's count of background work current. It changes outside the reducer's
    // events, so it is read again where it can change: at the end of a tool call (a job or
    // subagent started or stopped), at a background event (a job or subagent ended), and when a
    // subagent starts or ends its run.
    const syncBackground = (): void => {
      const work = agent.backgroundWork();
      const shown = state.status.background;
      if (
        work.jobs === shown.jobs &&
        work.subagents === shown.subagents &&
        work.queuedSubagents === shown.queuedSubagents
      ) {
        return;
      }
      dispatch({ type: 'status', patch: { background: work } });
    };

    const ticker = setInterval(() => {
      if (state.turn !== null || state.subagents.length > 0) scheduler.request();
    }, ANIMATION_MS);

    // Every step runs even if an earlier one throws: leaving the terminal in raw mode, with the
    // cursor hidden or with extended key reporting on, would break the user's shell.
    const finish = (code: number): void => {
      if (closed) return;
      closed = true;
      const steps: (() => void)[] = [
        () => cancelQuestion(),
        () => stopBackgroundEvents(),
        () => stopSubagentActivity(),
        () => autoContinue.dispose(),
        () => agent.cancelSubagents(),
        () => turn?.abort(),
        () => clearInterval(ticker),
        () => exitTimer !== null && clearTimeout(exitTimer),
        () => escTimer !== null && clearTimeout(escTimer),
        () => scheduler.close(),
        () => stdin.off('data', onData),
        () => disableBracketedPasteOn(write),
        () => write(disableModifyOtherKeys),
        () => disableRawMode(stdin),
        () => stdin.pause(),
        () => screen.clearLive(),
        () => screen.close(),
        () => process.off('uncaughtException', crash),
        () => process.off('unhandledRejection', crash),
      ];
      for (const step of steps) {
        try {
          step();
        } catch {
          // Restoring the rest of the terminal matters more than reporting this step.
        }
      }
      // A turn interrupted on the way out may not have reached its own checkpoint before the
      // process exits, so the conversation as it stands is saved first.
      void session.save().finally(() => resolveExit(code));
    };

    // Errors thrown from key, render or timer callbacks would otherwise end the process with the
    // terminal still in raw mode.
    function crash(error: unknown): void {
      finish(1);
      const detail =
        error instanceof Error && error.stack !== undefined ? error.stack : errorMessage(error);
      process.stderr.write(`nullrivet: unexpected error: ${detail}\n`);
    }
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);

    const slashContext: SlashContext = {
      agent,
      resolveModel: options.resolveModel,
      notice,
      clearScreen: () => {
        screen.clearScreen();
        dispatch({ type: 'status', patch: { contextTokens: null } });
      },
      exit: () => finish(0),
      stats: () => formatStats(state.status),
      session,
      cwd: options.cwd,
      ...(workspace === undefined ? {} : { workspace }),
      ask: (question) =>
        new Promise((resolveAnswer) => {
          cancelQuestion();
          notice('warning', question);
          answering = resolveAnswer;
        }),
      show: (item) => screen.print(formatPermanent(item, caps)),
      compact: async (instructions) => {
        // Registered as the running turn so Esc and Ctrl+C interrupt it and prompts wait for it.
        const controller = new AbortController();
        turn = controller;
        compacting = true;
        try {
          const outcome = await agent.compact({
            ...(instructions === undefined ? {} : { instructions }),
            signal: controller.signal,
            onEvent: (event) => dispatch({ type: 'agent', event, now: Date.now() }),
          });
          if (outcome === null) notice('info', 'There is nothing to compact yet.');
        } catch (error) {
          dispatch({ type: 'compact-cancelled' });
          if (controller.signal.aborted)
            notice('warning', 'Compaction interrupted; the conversation is unchanged.');
          else notice('error', errorMessage(error));
        } finally {
          compacting = false;
          if (turn === controller) turn = null;
          scheduler.request();
        }
      },
    };

    // A null text starts a turn on the pending background events alone. The session is
    // reserved (`turn`) before the first await, so nothing else can start a turn meanwhile.
    const startTurn = (text: string | null): void => {
      const controller = new AbortController();
      const startsBefore = agent.backgroundStarts();
      turn = controller;
      const runOptions = {
        signal: controller.signal,
        onEvent: (event: AgentEvent) => {
          dispatch({ type: 'agent', event, now: Date.now() });
          if (event.type === 'tool:end') syncBackground();
        },
      };
      (text === null ? agent.runOnBackgroundEvents(runOptions) : agent.run(text, runOptions))
        .then(
          (result) => {
            if (result !== null) {
              autoContinue.turnEnded(result.reason, agent.backgroundStarts() > startsBefore);
            }
          },
          (error: unknown) => {
            // runTurn reports its own failures; reaching this point means the turn ended without
            // its end event, so one is synthesized to leave the view consistent.
            dispatch({
              type: 'agent',
              event: { type: 'agent:end', reason: 'error', message: errorMessage(error) },
              now: Date.now(),
            });
            autoContinue.turnEnded('error', true);
          },
        )
        .finally(() => {
          if (turn === controller) turn = null;
          scheduler.request();
          autoContinue.poke();
        });
    };

    const interrupt = (): void => {
      if (turn === null || turn.signal.aborted) return;
      turn.abort();
      // Interrupting a task means stop: every background subagent is cancelled, including those
      // started by earlier turns, and events still pending must not start the agent again on their
      // own. Cancelling a /compact says nothing about the task.
      if (!compacting) {
        autoContinue.pause();
        agent.cancelSubagents();
      }
      dispatch({ type: 'interrupting' });
    };

    // Esc with no task running stops the background subagents. Their cancellations reach the model
    // with the next prompt; they do not start a turn to announce themselves.
    const cancelIdleSubagents = (): void => {
      autoContinue.pause();
      // A second Esc while the cancelled ones wind down stops nothing new and says nothing.
      if (agent.cancelSubagents() > 0) notice('info', 'Background subagents cancelled.');
    };

    // A command and a turn never overlap: /model and /instructions reload await work that must
    // not change the agent while a turn uses it.
    let commandRunning = false;

    // Starts turns on background events (jobs and subagents that ended) while the session is idle.
    // The automatic turn is an ordinary turn: Esc and Ctrl+C interrupt it, the current mode
    // applies, and it is saved. Every change that can make the session idle pokes it: the end of a
    // turn or a command, an emptied input, and an exit confirmation that expires.
    const autoContinue = createAutoContinue({
      isIdle: () =>
        !closed &&
        turn === null &&
        !commandRunning &&
        state.input.value.length === 0 &&
        state.exitArmedAt === null,
      hasEvents: () => agent.hasBackgroundEvents(),
      // Called right after hasEvents and isIdle, with no await in between: the events are there.
      start: () => {
        notice('info', 'Continuing on background events.');
        startTurn(null);
        return true;
      },
      notice: (text) => notice('info', text),
    });
    const stopBackgroundEvents = agent.onBackgroundEvent(() => {
      syncBackground();
      autoContinue.poke();
    });
    // Subagents outlive the turn that started them, so their activity reaches the interface through
    // the agent for as long as the session lasts.
    const stopSubagentActivity = agent.onSubagentActivity((event) => {
      dispatch({ type: 'agent', event, now: Date.now() });
      if (event.type === 'subagent:start' || event.type === 'subagent:end') syncBackground();
    });

    const updateSlash = (value: string): void => {
      const items = suggestCommands(value, workspace !== undefined).map((c) => ({
        name: c.name,
        description: c.description,
      }));
      const typed = /^\/([a-z]+)\s*$/.exec(value);
      const usage =
        typed?.[1] === undefined
          ? undefined
          : findCommand(typed[1], workspace !== undefined)?.usage;
      if (items.length === 0 && usage === undefined) {
        if (state.slash !== null) dispatch({ type: 'slash', menu: null });
        return;
      }
      dispatch({
        type: 'slash',
        menu: { items, selected: 0, ...(usage === undefined ? {} : { hint: ` ${usage}` }) },
      });
    };

    const setInput = (input: InputState): void => {
      dispatch({ type: 'input', input });
      updateSlash(input.value);
      // An automatic turn waits while the user types; an emptied input lets it start.
      if (input.value.length === 0) autoContinue.poke();
    };

    const runCommand = async (parsed: ParsedSlash): Promise<void> => {
      commandRunning = true;
      try {
        await runSlash(parsed, slashContext);
      } finally {
        commandRunning = false;
      }
      syncStatus();
      autoContinue.poke();
    };

    const submit = async (raw: string): Promise<void> => {
      const text = raw.trim();
      if (answering !== null) {
        // An answer, even an empty one, which cancels. It holds a confirmation code, so it is
        // not kept in the history.
        const answer = answering;
        answering = null;
        history.stopBrowsing();
        dispatch({ type: 'submit', text });
        answer(text);
        return;
      }
      if (text.length === 0) return;
      if (commandRunning) {
        notice('warning', 'A command is still running. Try again when it finishes.');
        return;
      }
      const parsed = parseSlash(raw);
      if (parsed !== null) {
        if (findCommand(parsed.name, workspace !== undefined) === undefined) {
          // The input is kept so the text is not lost when it was meant as a prompt.
          notice(
            'error',
            `Unknown command /${parsed.name}. Type /help for the list, or start the text with a space to send it as a prompt.`,
          );
          return;
        }
        history.add(raw.trimEnd());
        dispatch({ type: 'submit', text });
        await runCommand(parsed);
        return;
      }
      if (turn !== null) {
        notice('warning', 'A task is running. Wait for it to finish or press Esc to interrupt it.');
        return;
      }
      history.add(raw.trimEnd());
      dispatch({ type: 'submit', text });
      // Only an accepted prompt renews the automatic turns; the prompt's turn also takes any
      // pending job events, so the user goes first and nothing is lost.
      autoContinue.userPrompted();
      startTurn(text);
    };

    // Returns true when the key was consumed by the command popover.
    const handlePopoverKey = (key: KeyEvent): boolean => {
      const menu = state.slash;
      if (menu === null || menu.items.length === 0 || key.kind !== 'key') return false;
      const count = menu.items.length;
      if (key.name === 'up' || key.name === 'down') {
        const step = key.name === 'up' ? -1 : 1;
        dispatch({
          type: 'slash',
          menu: { ...menu, selected: (menu.selected + step + count) % count },
        });
        return true;
      }
      if (key.name === 'escape') {
        dispatch({ type: 'slash', menu: null });
        return true;
      }
      const chosen = menu.items[menu.selected];
      if (chosen === undefined) return false;
      if (key.name === 'tab') {
        history.stopBrowsing();
        const value = `/${chosen.name} `;
        setInput({ value, cursor: value.length });
        return true;
      }
      if (key.name === 'enter' && !key.shift && !key.alt) {
        void submit(`/${chosen.name}`);
        return true;
      }
      return false;
    };

    // ↑ on the first line of the input recalls the previous entry; once browsing, ↑ and ↓ walk
    // the history wherever the cursor is, and ↓ past the newest entry brings back the draft.
    const recall = (key: KeyEvent): boolean => {
      if (key.kind !== 'key' || key.ctrl || key.alt || key.shift) return false;
      const input = state.input;
      const onFirstLine = !input.value.slice(0, input.cursor).includes('\n');
      let text: string | null = null;
      if (key.name === 'up' && (history.browsing || onFirstLine)) {
        text = history.previous(input.value);
      } else if (key.name === 'down' && history.browsing) {
        text = history.next();
      }
      if (text === null) return false;
      setInput(inputWithText(text));
      return true;
    };

    // Exiting discards the changes of the workspace sandbox, so the exit command asks first.
    const requestExit = (): void => {
      if (workspace === undefined) finish(0);
      else if (!commandRunning) void runCommand({ name: 'exit', args: '' });
    };

    const onKey = (key: KeyEvent): void => {
      if (answering !== null && (isCtrlC(key) || isNamedKey(key, 'escape'))) {
        history.stopBrowsing();
        setInput({ value: '', cursor: 0 });
        cancelQuestion();
        return;
      }
      if (isCtrlC(key)) {
        if (turn !== null) {
          // A turn that does not settle after an interrupt (a process that ignores signals, a
          // silent stream) must not keep the user from leaving.
          if (turn.signal.aborted) finish(130);
          else interrupt();
        } else if (state.input.value.length > 0) {
          history.stopBrowsing();
          setInput({ value: '', cursor: 0 });
        } else if (state.exitArmedAt !== null) {
          // Nothing is interrupted: leaving an idle session this way is as deliberate as /exit.
          finish(0);
        } else {
          // The changes the exit would discard, counted when the exit is armed. Refusals, such as
          // those of .git, are never applied, and do not count.
          let discards = 0;
          if (workspace?.active === true) {
            const preview = workspace.preview();
            discards = 'error' in preview ? -1 : preview.pending;
          }
          dispatch({ type: 'exit-arm', now: Date.now(), discards });
          if (exitTimer !== null) clearTimeout(exitTimer);
          exitTimer = setTimeout(() => {
            dispatch({ type: 'exit-disarm' });
            autoContinue.poke();
          }, EXIT_ARM_MS);
        }
        return;
      }
      // A recalled command opens the command list, which would otherwise take ↑ and ↓ over.
      if (history.browsing && recall(key)) return;
      if (handlePopoverKey(key)) return;
      if (recall(key)) return;
      if (isShiftTab(key)) {
        // Also while a task runs: the tool broker reads the mode before every tool call, so the
        // switch applies from the next one, as with /permission. The notice records the switch
        // in the scrollback, the only record of which mode the tool calls around it ran in.
        agent.mode = agent.mode === 'auto' ? 'readonly' : 'auto';
        dispatch({ type: 'exit-disarm' });
        syncStatus();
        notice('info', describeModeChange(agent.mode));
        void agent.checkpoint?.();
        return;
      }
      if (isNamedKey(key, 'escape') && turn === null && agent.runningSubagents() > 0) {
        cancelIdleSubagents();
        return;
      }
      if (isNamedKey(key, 'escape') && turn !== null) {
        interrupt();
        return;
      }
      const result = applyKey(state.input, key);
      if (result.submit !== undefined) {
        void submit(result.submit.text);
        return;
      }
      if (result.cancelInput === 'eof') {
        if (turn === null) requestExit();
        return;
      }
      if (result.next.value !== state.input.value) history.stopBrowsing();
      if (result.next !== state.input) setInput(result.next);
    };

    const parser = createKeyParser();
    const onData = (data: Buffer): void => {
      for (const key of parser.feed(data)) onKey(key);
      if (escTimer !== null) clearTimeout(escTimer);
      escTimer =
        parser.bufferLength() > 0
          ? setTimeout(() => {
              for (const key of parser.tryResolveLoneEsc()) onKey(key);
            }, ESC_DRAIN_MS)
          : null;
    };

    screen.onResize((size) => {
      caps = { ...caps, cols: size.columns, rows: size.rows };
      scheduler.flush();
    });
    options.signal.addEventListener('abort', () => finish(130), { once: true });

    screen.print(
      formatPermanent(
        {
          kind: 'banner',
          version: options.version,
          model: agent.provider.id,
          mode: agent.mode,
          ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
          effort: agent.effort,
          cwd: options.cwd,
          home: homedir(),
          instructions: agent.instructions().length,
        },
        caps,
      ),
    );
    for (const warning of options.warnings) notice('warning', warning);
    if (session.path !== null) {
      notice(
        'info',
        options.resumedMessages === null
          ? `Saving this session to ${session.path}.`
          : `Resumed the session in ${session.path} (${options.resumedMessages} messages).`,
      );
    }

    enableRawMode(stdin);
    enableBracketedPasteOn(write);
    // Makes xterm report Shift+Enter distinctly, so it can insert a newline instead of submitting.
    write(enableModifyOtherKeys);
    stdin.on('data', onData);
    stdin.resume();
    scheduler.flush();
  });
