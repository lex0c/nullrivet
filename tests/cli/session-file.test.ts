import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../src/agent/agent.ts';
import { Conversation } from '../../src/agent/conversation.ts';
import { IN_PROCESS_BACKEND } from '../../src/agent/tool-broker.ts';
import { PromptHistory } from '../../src/cli/prompt-history.ts';
import {
  parseSessionFile,
  SESSION_FORMAT,
  SessionFile,
  SessionLink,
  type SessionState,
} from '../../src/cli/session-file.ts';
import { createMockProvider } from '../helpers/mock-provider.ts';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nullrivet-session-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const state = (text = 'hello'): SessionState => {
  const c = new Conversation();
  c.appendUser(text);
  c.appendAssistant([{ type: 'text', text: 'hi' }]);
  return {
    model: 'openai/gpt-5.4-mini',
    effort: 'medium',
    mode: 'readonly',
    sandbox: undefined,
    cwd: '/work',
    conversation: c.snapshot(),
    history: [text],
  };
};

const openOk = async (path: string) => {
  const opened = await SessionFile.open(path);
  if (!opened.ok) throw new Error(opened.error);
  return opened;
};

describe('SessionFile', () => {
  test('a new file is created on the first save, readable by its owner only', async () => {
    const path = join(tempDir(), 's.json');
    const opened = await openOk(path);
    expect(opened.data).toBeNull();
    await opened.file.save(state());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = await openOk(path);
    expect(reopened.data).toMatchObject({
      model: 'openai/gpt-5.4-mini',
      effort: 'medium',
      mode: 'readonly',
      cwd: '/work',
      history: ['hello'],
    });
    expect(reopened.data?.conversation).toEqual(state().conversation);
  });

  test('the sandbox profile is optional, checked, and saved only when there is one', async () => {
    const parse = (sandbox: unknown) =>
      parseSessionFile(
        JSON.stringify({
          format: SESSION_FORMAT,
          version: 1,
          createdAt: 'a',
          updatedAt: 'b',
          ...state(),
          sandbox,
        }),
      );
    const absent = parse(undefined);
    expect(absent.ok && absent.data.sandbox).toBeUndefined();
    const inspect = parse('inspect');
    expect(inspect.ok && inspect.data.sandbox).toBe('inspect');
    const unknown = parse('none');
    expect(unknown.ok ? 'ok' : unknown.error).toBe('sandbox must be inspect or workspace');
    const path = join(tempDir(), 's.json');
    const { file } = await openOk(path);
    await file.save(state());
    expect(readFileSync(path, 'utf8')).not.toContain('"sandbox"');
    await file.save({ ...state(), sandbox: 'inspect' });
    expect(JSON.parse(readFileSync(path, 'utf8')).sandbox).toBe('inspect');
  });

  test('the prompt history is optional, checked, and kept to its limit when loaded', () => {
    const base = JSON.parse(
      JSON.stringify({
        format: SESSION_FORMAT,
        version: 1,
        createdAt: 'a',
        updatedAt: 'b',
        ...state(),
      }),
    );
    const withHistory = (history: unknown) => {
      const { history: _, ...rest } = base;
      return parseSessionFile(JSON.stringify(history === undefined ? rest : { ...rest, history }));
    };
    const absent = withHistory(undefined);
    expect(absent.ok && absent.data.history).toEqual([]);
    const invalid = withHistory(['ok', 3]);
    expect(invalid.ok ? 'ok' : invalid.error).toContain('history must be an array of strings');
    const long = withHistory(Array.from({ length: 600 }, (_, i) => `p${i}`));
    expect(long.ok && long.data.history.length).toBe(100);
    expect(long.ok && long.data.history.at(-1)).toBe('p599');
  });

  test('later saves replace the content and keep the creation time', async () => {
    const path = join(tempDir(), 's.json');
    const { file } = await openOk(path);
    await file.save(state('first'));
    const created = JSON.parse(readFileSync(path, 'utf8')).createdAt;
    await file.save(state('second'));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.createdAt).toBe(created);
    expect(JSON.stringify(saved.conversation)).toContain('second');
  });

  test('a file changed by something else is not overwritten', async () => {
    const path = join(tempDir(), 's.json');
    const { file } = await openOk(path);
    await file.save(state());
    writeFileSync(path, 'edited by hand');
    await expect(file.save(state('again'))).rejects.toThrow('changed by something else');
    expect(readFileSync(path, 'utf8')).toBe('edited by hand');
  });

  test('a file that appeared after a new session was opened is not overwritten', async () => {
    const path = join(tempDir(), 's.json');
    const { file } = await openOk(path);
    writeFileSync(path, 'another process');
    await expect(file.save(state())).rejects.toThrow('changed by something else');
  });

  test('files that are not session files are refused and left untouched', async () => {
    const dir = tempDir();
    const cases: [string, string, string][] = [
      ['notes.txt', 'plain text', 'not JSON'],
      ['other.json', '{"name":"package"}', 'not a nullrivet session file'],
      [
        'future.json',
        JSON.stringify({ format: SESSION_FORMAT, version: 99 }),
        'version 99 is not supported',
      ],
    ];
    for (const [name, content, error] of cases) {
      const path = join(dir, name);
      writeFileSync(path, content);
      const opened = await SessionFile.open(path);
      expect(opened.ok ? 'opened' : opened.error).toContain(error);
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
  });

  test('symbolic links, directories, missing directories and huge files are refused', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'target.json'), '{}');
    symlinkSync(join(dir, 'target.json'), join(dir, 'link.json'));
    const huge = join(dir, 'huge.json');
    writeFileSync(huge, '');
    truncateSync(huge, 65 * 1024 * 1024);
    const errors = await Promise.all(
      [join(dir, 'link.json'), dir, join(dir, 'missing', 's.json'), huge].map(async (path) => {
        const opened = await SessionFile.open(path);
        return opened.ok ? 'opened' : opened.error;
      }),
    );
    expect(errors[0]).toContain('symbolic link');
    expect(errors[1]).toContain('not a regular file');
    expect(errors[2]).toContain('directory of the session file does not exist');
    expect(errors[3]).toContain('larger than 64 MiB');
  });

  test('an invalid conversation inside a session file is refused', () => {
    const parsed = parseSessionFile(
      JSON.stringify({
        format: SESSION_FORMAT,
        version: 1,
        createdAt: 'a',
        updatedAt: 'b',
        model: 'm',
        mode: 'auto',
        cwd: '/',
        conversation: { messages: [{ role: 'assistant', content: 'x' }], summary: null },
      }),
    );
    expect(parsed.ok ? 'ok' : parsed.error).toContain('start with a user message');
  });
});

describe('SessionLink', () => {
  const agentWith = async () =>
    createAgent({
      toolBackend: IN_PROCESS_BACKEND,
      provider: createMockProvider([]),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });

  test('saves through the agent checkpoint while attached', async () => {
    const agent = await agentWith();
    const path = join(tempDir(), 's.json');
    const link = new SessionLink(agent, '/tmp', () => undefined, new PromptHistory());
    link.attach((await openOk(path)).file);
    agent.conversation.appendUser('remember me');
    await agent.checkpoint?.();
    expect(readFileSync(path, 'utf8')).toContain('remember me');
    link.detach();
    expect(agent.checkpoint).toBeNull();
  });

  test('a file that cannot be written is detached with one warning', async () => {
    const agent = await agentWith();
    const path = join(tempDir(), 's.json');
    const warnings: string[] = [];
    const link = new SessionLink(
      agent,
      '/tmp',
      (message) => warnings.push(message),
      new PromptHistory(),
    );
    link.attach((await openOk(path)).file);
    await link.save();
    writeFileSync(path, 'replaced');
    agent.conversation.appendUser('more');
    await link.save();
    agent.conversation.appendAssistant([{ type: 'text', text: 'again' }]);
    await link.save();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no longer saved');
    expect(link.path).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('replaced');
  });

  test('a new history entry alone is saved', async () => {
    const agent = await agentWith();
    const path = join(tempDir(), 's.json');
    const history = new PromptHistory();
    const link = new SessionLink(agent, '/tmp', () => undefined, history);
    link.attach((await openOk(path)).file);
    await link.save();
    history.add('/stats');
    await link.save();
    expect(JSON.parse(readFileSync(path, 'utf8')).history).toEqual(['/stats']);
  });

  test('a state that has not changed is not written again', async () => {
    const agent = await agentWith();
    const path = join(tempDir(), 's.json');
    const link = new SessionLink(agent, '/tmp', () => undefined, new PromptHistory());
    link.attach((await openOk(path)).file);
    agent.conversation.appendUser('once');
    await link.save();
    const first = statSync(path).ino;
    await link.save();
    expect(statSync(path).ino).toBe(first);
    agent.effort = 'high';
    await link.save();
    expect(statSync(path).ino).not.toBe(first);
  });

  test('a session that outgrows the size limit stops being saved and keeps its last state', async () => {
    const agent = await agentWith();
    const path = join(tempDir(), 's.json');
    const warnings: string[] = [];
    const link = new SessionLink(
      agent,
      '/tmp',
      (message) => warnings.push(message),
      new PromptHistory(),
    );
    const opened = await SessionFile.open(path, { maxBytes: 4_000 });
    if (!opened.ok) throw new Error(opened.error);
    link.attach(opened.file);
    agent.conversation.appendUser('small');
    await link.save();
    const saved = readFileSync(path, 'utf8');
    agent.conversation.appendAssistant([{ type: 'text', text: 'x'.repeat(5_000) }]);
    await link.save();
    expect(warnings[0]).toContain('grown past');
    expect(link.path).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(saved);
  });

  test('switching to a file that cannot be written keeps the current one', async () => {
    const agent = await agentWith();
    const dir = tempDir();
    const link = new SessionLink(agent, '/tmp', () => undefined, new PromptHistory());
    link.attach((await openOk(join(dir, 'a.json'))).file);
    agent.conversation.appendUser('first');
    await link.save();
    // A file that appears between opening and the first write stands in for a write that fails.
    const target = await openOk(join(dir, 'b.json'));
    writeFileSync(join(dir, 'b.json'), 'someone else');
    const failure = await link.switchTo(target.file);
    expect(failure).toContain('changed by something else');
    expect(link.path).toBe(join(dir, 'a.json'));
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('someone else');
  });
});
