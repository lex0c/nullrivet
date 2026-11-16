import { describe, expect, test } from 'bun:test';
import { type Agent, createAgent } from '../../src/agent/agent.ts';
import { parseSlash, runSlash, type SlashContext, suggestCommands } from '../../src/cli/slash.ts';
import type { ResolveResult } from '../../src/providers/resolve.ts';
import { createMockProvider } from '../helpers/mock-provider.ts';

interface Harness {
  agent: Agent;
  ctx: SlashContext;
  notices: { level: string; text: string }[];
  cleared: number;
  exited: number;
}

const harness = async (resolve?: (id: string) => ResolveResult): Promise<Harness> => {
  const agent = await createAgent({
    provider: createMockProvider([]),
    tools: [],
    mode: 'auto',
    cwd: '/tmp',
    instructions: null,
  });
  const h: Harness = { agent, notices: [], cleared: 0, exited: 0, ctx: undefined as never };
  h.ctx = {
    agent,
    resolveModel: async (id) => resolve?.(id) ?? { ok: false, error: `unknown ${id}` },
    notice: (level, text) => h.notices.push({ level, text }),
    clearScreen: () => {
      h.cleared += 1;
    },
    exit: () => {
      h.exited += 1;
    },
    stats: () => 'stats text',
  };
  return h;
};

const run = async (h: Harness, text: string): Promise<void> => {
  const parsed = parseSlash(text);
  if (parsed === null) throw new Error(`not a command: ${text}`);
  await runSlash(parsed, h.ctx);
};

describe('parseSlash', () => {
  test('parses a command and its arguments', () => {
    expect(parseSlash('/model openrouter/a/b')).toEqual({ name: 'model', args: 'openrouter/a/b' });
    expect(parseSlash('/help  ')).toEqual({ name: 'help', args: '' });
  });

  test('a path or ordinary text is not a command', () => {
    expect(parseSlash('/etc/hosts is broken')).toBeNull();
    expect(parseSlash('fix /model')).toBeNull();
    expect(parseSlash('/')).toBeNull();
    expect(parseSlash(' /tmp is full')).toBeNull();
  });
});

describe('suggestCommands', () => {
  test('filters by the typed prefix while the name is incomplete', () => {
    expect(suggestCommands('/e').map((c) => c.name)).toEqual(['effort', 'exit']);
    expect(suggestCommands('/').length).toBeGreaterThan(5);
    expect(suggestCommands('/effort high')).toEqual([]);
    expect(suggestCommands('hello')).toEqual([]);
  });
});

describe('runSlash', () => {
  test('changes the execution mode and the effort', async () => {
    const h = await harness();
    await run(h, '/permission readonly');
    expect(h.agent.mode).toBe('readonly');
    await run(h, '/effort high');
    expect(h.agent.effort).toBe('high');
    await run(h, '/effort off');
    expect(h.agent.effort).toBeUndefined();
  });

  test('rejects invalid values without changing anything', async () => {
    const h = await harness();
    await run(h, '/permission yolo');
    await run(h, '/effort extreme');
    expect(h.agent.mode).toBe('auto');
    expect(h.agent.effort).toBeUndefined();
    expect(h.notices.map((n) => n.level)).toEqual(['error', 'error']);
  });

  test('switches the model only when it resolves', async () => {
    const replacement = createMockProvider([]);
    const h = await harness((id) =>
      id === 'openrouter/good'
        ? { ok: true, provider: replacement, source: 'discovery', warnings: ['note'] }
        : { ok: false, error: 'nope' },
    );
    await run(h, '/model openrouter/bad');
    expect(h.agent.provider).not.toBe(replacement);
    await run(h, '/model openrouter/good');
    expect(h.agent.provider).toBe(replacement);
    expect(h.notices.map((n) => n.level)).toEqual(['error', 'warning', 'info']);
  });

  test('clear discards the conversation and the screen', async () => {
    const h = await harness();
    h.agent.conversation.appendUser('hello');
    await run(h, '/clear');
    expect(h.agent.conversation.length).toBe(0);
    expect(h.cleared).toBe(1);
  });

  test('unknown commands are reported', async () => {
    const h = await harness();
    await run(h, '/frobnicate');
    expect(h.notices[0]?.text).toContain('Unknown command /frobnicate');
  });

  test('exit and stats delegate to the caller', async () => {
    const h = await harness();
    await run(h, '/stats');
    await run(h, '/exit');
    expect(h.notices[0]?.text).toBe('stats text');
    expect(h.exited).toBe(1);
  });
});
