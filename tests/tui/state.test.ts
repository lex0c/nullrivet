import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../../src/agent/events.ts';
import {
  type Action,
  createInitialState,
  type PermanentItem,
  reduce,
  type TuiState,
} from '../../src/tui/state.ts';

const initial = (): TuiState =>
  createInitialState({
    model: 'openrouter/m',
    mode: 'auto',
    effort: undefined,
    cwd: '/work',
    home: '/home/u',
    contextWindow: 100_000,
  });

const run = (actions: Action[], start = initial()) => {
  let state = start;
  const permanent: PermanentItem[] = [];
  for (const action of actions) {
    const r = reduce(state, action);
    state = r.state;
    permanent.push(...r.permanent);
  }
  return { state, permanent };
};

const ev = (event: AgentEvent, now = 0): Action => ({ type: 'agent', event, now });

describe('reduce', () => {
  test('a submitted prompt is echoed and clears the input', () => {
    const { state, permanent } = run([
      { type: 'input', input: { value: 'hello', cursor: 5 } },
      { type: 'submit', text: 'hello' },
    ]);
    expect(state.input).toEqual({ value: '', cursor: 0 });
    expect(permanent).toEqual([{ kind: 'user', text: 'hello' }]);
  });

  test('streamed text settles block by block and the rest is flushed at the end', () => {
    const { state, permanent } = run([
      ev({ type: 'agent:start' }, 1_000),
      ev({ type: 'text:delta', text: 'First para' }),
      ev({ type: 'text:delta', text: 'graph.\n\nSecond' }),
    ]);
    expect(permanent).toEqual([{ kind: 'assistant', markdown: 'First paragraph.' }]);
    expect(state.turn?.pendingText).toBe('Second');
    const end = run([ev({ type: 'agent:end', reason: 'done' }, 4_000)], state);
    expect(end.permanent).toEqual([
      { kind: 'assistant', markdown: 'Second' },
      { kind: 'turn-end', reason: 'done', message: undefined, durationMs: 3_000 },
    ]);
    expect(end.state.turn).toBeNull();
  });

  test('text before a tool call is settled when the tool starts', () => {
    const { state, permanent } = run([
      ev({ type: 'agent:start' }),
      ev({ type: 'text:delta', text: 'Let me check.' }),
      ev({ type: 'tool:start', id: 't1', name: 'bash', args: { command: 'ls' }, step: 1 }, 100),
    ]);
    expect(permanent).toEqual([{ kind: 'assistant', markdown: 'Let me check.' }]);
    expect(state.turn?.tools.map((t) => t.id)).toEqual(['t1']);
    const done = run(
      [
        ev(
          { type: 'tool:end', id: 't1', name: 'bash', content: 'a\n[exit code 0]', isError: false },
          350,
        ),
      ],
      state,
    );
    expect(done.permanent).toEqual([
      {
        kind: 'tool',
        name: 'bash',
        args: { command: 'ls' },
        isError: false,
        content: 'a\n[exit code 0]',
        meta: undefined,
        durationMs: 250,
      },
    ]);
    expect(done.state.turn?.tools).toEqual([]);
  });

  test('thinking is tracked until text arrives', () => {
    const { state } = run([
      ev({ type: 'agent:start' }),
      ev({ type: 'thinking:delta', text: 'hmm' }, 500),
      ev({ type: 'thinking:delta', text: 'more' }, 900),
    ]);
    expect(state.turn?.thinkingSince).toBe(500);
    const after = run([ev({ type: 'text:delta', text: 'Answer' })], state);
    expect(after.state.turn?.thinkingSince).toBeNull();
  });

  test('usage updates the context size and the session totals', () => {
    const { state } = run([
      ev({ type: 'usage', input: 100, output: 20, cacheRead: 50, cacheWrite: 10 }),
      ev({ type: 'usage', input: 30, output: 5, cacheRead: 200, cacheWrite: 0 }),
    ]);
    expect(state.status.contextTokens).toBe(235);
    expect(state.status.totals).toEqual({
      input: 130,
      output: 25,
      cacheRead: 250,
      cacheWrite: 10,
      requests: 2,
    });
  });

  test('warnings, errors and notices go to the scrollback', () => {
    const { permanent } = run([
      ev({ type: 'warning', message: 'w' }),
      ev({ type: 'error', message: 'e' }),
      { type: 'notice', level: 'info', text: 'i' },
      ev({ type: 'notice', text: 'Background job x completed' }),
    ]);
    expect(permanent.map((p) => (p.kind === 'notice' ? p.level : p.kind))).toEqual([
      'warning',
      'error',
      'info',
      'info',
    ]);
    expect(permanent.at(-1)).toMatchObject({ text: 'Background job x completed' });
  });

  test('typing disarms a pending exit', () => {
    const armed = run([{ type: 'exit-arm', now: 10 }]).state;
    expect(armed.exitArmedAt).toBe(10);
    expect(
      run([{ type: 'input', input: { value: 'x', cursor: 1 } }], armed).state.exitArmedAt,
    ).toBeNull();
  });
  test('compaction shows progress, then a notice with the new context size', () => {
    const started = run([ev({ type: 'context:compact:start', reason: 'manual' }, 100)]);
    expect(started.state.compacting).toEqual({ reason: 'manual', since: 100 });
    const done = run(
      [
        ev({
          type: 'usage',
          input: 9_000,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          compaction: true,
        }),
        ev({
          type: 'context:compact',
          reason: 'manual',
          strategy: 'llm',
          before: 90_000,
          after: 20_000,
        }),
      ],
      started.state,
    );
    expect(done.state.compacting).toBeNull();
    expect(done.state.status.contextTokens).toBe(20_000);
    expect(done.state.status.totals.input).toBe(9_000);
    expect(done.permanent).toEqual([
      { kind: 'notice', level: 'info', text: 'Context compacted: 90k → 20k tokens (estimated).' },
    ]);
  });

  test('a compaction without a summary is reported as a warning', () => {
    const { permanent } = run([
      ev({
        type: 'context:compact',
        reason: 'auto',
        strategy: 'fallback',
        before: 5_000,
        after: 1_000,
      }),
    ]);
    expect(permanent[0]).toMatchObject({ kind: 'notice', level: 'warning' });
  });
  test('the end of a turn clears a compaction that was interrupted', () => {
    const { state } = run([
      ev({ type: 'agent:start' }),
      ev({ type: 'context:compact:start', reason: 'auto' }, 10),
      ev({ type: 'agent:end', reason: 'aborted' }, 20),
    ]);
    expect(state.compacting).toBeNull();
  });
});

describe('subagents', () => {
  test('progress shows on the delegate card, and their usage does not move the context gauge', () => {
    const { state } = run([
      ev({ type: 'agent:start' }),
      ev({ type: 'tool:start', id: 'd1', name: 'delegate', args: { title: 'scan' }, step: 1 }, 5),
      ev({ type: 'subagent:start', id: 'd1', title: 'scan', mode: 'readonly' }, 6),
      ev(
        {
          type: 'subagent:progress',
          id: 'd1',
          step: 2,
          tool: { name: 'grep', args: { pattern: 'TODO' } },
        },
        7,
      ),
      ev(
        {
          type: 'usage',
          input: 900,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          subagent: 'd1',
        },
        8,
      ),
    ]);
    expect(state.turn?.tools[0]?.subagent).toEqual({
      step: 2,
      tool: { name: 'grep', args: { pattern: 'TODO' } },
    });
    expect(state.status.contextTokens).toBeNull();
    expect(state.status.totals.input).toBe(900);
  });
});
