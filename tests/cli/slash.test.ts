import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Agent, createAgent } from '../../src/agent/agent.ts';
import { IN_PROCESS_BACKEND } from '../../src/agent/tool-broker.ts';
import { PromptHistory } from '../../src/cli/prompt-history.ts';
import { SessionLink } from '../../src/cli/session-file.ts';
import {
  findCommand,
  parseSlash,
  runSlash,
  type SlashContext,
  suggestCommands,
} from '../../src/cli/slash.ts';
import type { WorkspaceSession } from '../../src/cli/workspace-session.ts';
import { InstructionsLoader } from '../../src/instructions/agents-loader.ts';
import type { ResolveResult } from '../../src/providers/resolve.ts';
import { createMockProvider } from '../helpers/mock-provider.ts';

interface Harness {
  agent: Agent;
  ctx: SlashContext;
  notices: { level: string; text: string }[];
  cleared: number;
  exited: number;
  compacted: number;
}

const harness = async (
  resolve?: (id: string) => ResolveResult,
  cwd = '/tmp',
  instructions: InstructionsLoader | null = null,
): Promise<Harness> => {
  const agent = await createAgent({
    toolBackend: IN_PROCESS_BACKEND,
    provider: createMockProvider([]),
    tools: [],
    mode: 'auto',
    cwd,
    instructions,
  });
  const h: Harness = {
    agent,
    notices: [],
    cleared: 0,
    exited: 0,
    compacted: 0,
    ctx: undefined as never,
  };
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
    compact: async () => {
      h.compacted += 1;
    },
    session: new SessionLink(
      agent,
      cwd,
      (text) => h.notices.push({ level: 'warning', text }),
      new PromptHistory(),
    ),
    cwd,
    ask: async () => null,
    show: () => undefined,
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
  test('offers the commands of the workspace sandbox in its sessions only', () => {
    expect(suggestCommands('/ap').map((c) => c.name)).toEqual([]);
    expect(suggestCommands('/ap', true).map((c) => c.name)).toEqual(['apply']);
    expect(findCommand('discard')).toBeUndefined();
    expect(findCommand('changes', true)?.usage).toBe('[path]');
  });

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

  test('compact delegates to the caller', async () => {
    const h = await harness();
    await run(h, '/compact focus on the parser');
    expect(h.compacted).toBe(1);
  });

  test('exit and stats delegate to the caller', async () => {
    const h = await harness();
    await run(h, '/stats');
    await run(h, '/exit');
    expect(h.notices[0]?.text).toBe('stats text');
    expect(h.exited).toBe(1);
  });
});

describe('/apply', () => {
  test('reads the AGENTS.md files again once an application changed them', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-slash-apply-')));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'old rules');
      const h = await harness(undefined, dir, new InstructionsLoader());
      expect(h.agent.instructions().map((file) => file.content)).toEqual(['old rules']);
      // A workspace whose application writes AGENTS.md, as the ChangeSet would.
      h.ctx.workspace = {
        root: dir,
        active: true,
        busy: false,
        runningJobs: () => 0,
        preview: () => ({
          entries: [{ path: 'AGENTS.md', change: 'modified', kind: 'file' }],
          shown: new Set<string>(),
          pending: 1,
        }),
        apply: async () => {
          writeFileSync(join(dir, 'AGENTS.md'), 'new rules');
          return {
            report: { applied: ['AGENTS.md'], notApplied: [], stopped: null },
            failure: null,
            instructionsChanged: true,
            stopped: null,
            warnings: [],
          };
        },
      } as unknown as WorkspaceSession;
      h.ctx.ask = async (question) => `apply ${/apply ([0-9A-F]{4})/.exec(question)?.[1]}`;
      await run(h, '/apply');
      expect(h.agent.instructions().map((file) => file.content)).toEqual(['new rules']);
      expect(h.notices.map((notice) => notice.text)).toContain(
        'AGENTS.md files of the project may have changed: the instructions were read again.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('/session', () => {
  const sessionDir = (): string => mkdtempSync(join(tmpdir(), 'nullrivet-slash-session-'));

  test('shows that nothing is attached, then saves to a new file relative to the session directory', async () => {
    const dir = sessionDir();
    try {
      const h = await harness(undefined, dir);
      await run(h, '/session');
      expect(h.notices.at(-1)?.text).toContain('No session file is attached');
      h.agent.conversation.appendUser('keep this');
      await run(h, '/session saved.json');
      expect(readFileSync(join(dir, 'saved.json'), 'utf8')).toContain('keep this');
      expect(h.notices.at(-1)?.text).toBe(`Saving this session to ${join(dir, 'saved.json')}.`);
      await run(h, '/session');
      expect(h.notices.at(-1)?.text).toContain(`Session file: ${join(dir, 'saved.json')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('in the workspace sandbox, refuses a file in the project, under its overlay', async () => {
    const dir = realpathSync(sessionDir());
    try {
      const h = await harness(undefined, dir);
      // The command reads the project's path only.
      h.ctx.workspace = { root: dir } as unknown as WorkspaceSession;
      await run(h, '/session saved.json');
      expect(existsSync(join(dir, 'saved.json'))).toBe(false);
      expect(h.notices.at(-1)).toEqual({
        level: 'error',
        text: `the session file ${join(dir, 'saved.json')} is in the project, which the workspace sandbox does not change while it runs; save it outside the project`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('switching files forks the session, and an existing session is never overwritten', async () => {
    const dir = sessionDir();
    try {
      const h = await harness(undefined, dir);
      h.agent.conversation.appendUser('first part');
      await run(h, '/session a.json');
      await run(h, '/session b.json');
      expect(h.notices.at(-1)?.text).toContain('a.json keeps the conversation as it was until now');
      const before = readFileSync(join(dir, 'a.json'), 'utf8');
      await run(h, '/session a.json');
      expect(h.notices.at(-1)).toMatchObject({ level: 'error' });
      expect(h.notices.at(-1)?.text).toContain('already holds a session');
      expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('off stops saving and keeps the file', async () => {
    const dir = sessionDir();
    try {
      const h = await harness(undefined, dir);
      await run(h, '/session s.json');
      await run(h, '/session off');
      expect(h.agent.checkpoint).toBeNull();
      expect(h.notices.at(-1)?.text).toContain('No longer saving to');
      expect(existsSync(join(dir, 's.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/clear keeps the saved conversation in its file and stops saving', async () => {
    const dir = sessionDir();
    try {
      const h = await harness(undefined, dir);
      h.agent.conversation.appendUser('worth keeping');
      await run(h, '/session s.json');
      await run(h, '/clear');
      expect(h.agent.checkpoint).toBeNull();
      expect(h.notices.at(-1)?.text).toContain('keeps the previous conversation');
      expect(readFileSync(join(dir, 's.json'), 'utf8')).toContain('worth keeping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a change of effort is saved to the session file', async () => {
    const dir = sessionDir();
    try {
      const h = await harness(undefined, dir);
      await run(h, '/session s.json');
      await run(h, '/effort high');
      expect(JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')).effort).toBe('high');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
