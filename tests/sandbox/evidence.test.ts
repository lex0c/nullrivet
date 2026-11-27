import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EvidenceEntry,
  type EvidenceFs,
  EvidenceLog,
  sha256,
  ZERO_HASH,
} from '../../src/sandbox/evidence.ts';
import { companionOf, verifyEvidence } from '../../src/sandbox/evidence-verify.ts';
import {
  hostSecrets,
  redactExact,
  redactStrings,
  redactText,
} from '../../src/sandbox/redaction.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nullrivet-evidence-'));
  dirs.push(dir);
  return dir;
};

const lines = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

describe('the evidence log', () => {
  test('chains each line to the one before, from a hash of zeros', () => {
    const path = join(scratch(), 'session.jsonl');
    const fd = openSync(path, 'wx', 0o600);
    const log = new EvidenceLog({ fd, onFailure: () => undefined });
    expect(log.appendCritical({ type: 'session.started' })).toBe(true);
    log.append({ type: 'tool.started', callId: 'c1' });
    log.append({ type: 'session.ended' });
    closeSync(fd);
    const written = lines(path);
    const parsed = written.map((line) => JSON.parse(line));
    expect(parsed.map((entry) => [entry.seq, entry.type])).toEqual([
      [1, 'session.started'],
      [2, 'tool.started'],
      [3, 'session.ended'],
    ]);
    expect(parsed[0].prev).toBe(ZERO_HASH);
    expect(parsed[1].prev).toBe(sha256(`${written[0]}\n`));
    expect(parsed[2].prev).toBe(sha256(`${written[1]}\n`));
    expect(log.lastHash).toBe(sha256(`${written[2]}\n`));
    expect(log.entries).toBe(3);
  });

  test('writes a line whole across partial writes, and syncs what an action depends on', () => {
    const path = join(scratch(), 'session.jsonl');
    const fd = openSync(path, 'wx', 0o600);
    let syncs = 0;
    const fs: EvidenceFs = {
      writeSync: (to, buffer, offset, length) => writeSync(to, buffer, offset, Math.min(length, 7)),
      fsyncSync: (to) => {
        syncs += 1;
        fsyncSync(to);
      },
    };
    const log = new EvidenceLog({ fd, fs, onFailure: () => undefined });
    log.appendCritical({ type: 'session.started', engagement: { name: 'a long enough value' } });
    log.append({ type: 'tool.finished', callId: 'c1' });
    log.append({ type: 'scope.refreshed' }, true);
    closeSync(fd);
    expect(lines(path).map((line) => JSON.parse(line).type)).toEqual([
      'session.started',
      'tool.finished',
      'scope.refreshed',
    ]);
    expect(syncs).toBe(2);
  });

  test('fails once, at a write, a sync or its limit, and writes nothing more', () => {
    for (const how of ['write', 'sync', 'limit'] as const) {
      const fd = openSync(join(scratch(), 'session.jsonl'), 'wx', 0o600);
      const failures: string[] = [];
      let writes = 0;
      const fs: EvidenceFs = {
        writeSync: (to, buffer, offset, length) => {
          writes += 1;
          if (how === 'write' && writes > 1) {
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          }
          return writeSync(to, buffer, offset, length);
        },
        fsyncSync: (to) => {
          if (how === 'sync' && writes > 1) throw new Error('input/output error');
          fsyncSync(to);
        },
      };
      const log = new EvidenceLog({
        fd,
        fs,
        onFailure: (reason) => failures.push(reason),
        ...(how === 'limit' ? { maxBytes: 200 } : {}),
      });
      expect(log.appendCritical({ type: 'session.started' })).toBe(true);
      expect(
        log.appendCritical({ type: 'tool.started', callId: 'c1', padding: 'x'.repeat(100) }),
      ).toBe(false);
      expect(log.appendCritical({ type: 'tool.started', callId: 'c2' })).toBe(false);
      log.append({ type: 'session.ended' });
      expect(failures).toHaveLength(1);
      expect(log.failed()).toBe(failures[0] as string);
      expect(log.entries).toBe(1);
      closeSync(fd);
    }
  });

  test('waits for the preservations under way, as long as it is given', async () => {
    const fd = openSync(join(scratch(), 'session.jsonl'), 'wx', 0o600);
    const log = new EvidenceLog({ fd, onFailure: () => undefined });
    void log.track(new Promise((resolve) => setTimeout(resolve, 30)));
    expect(await log.drain(1_000)).toBe(0);
    void log.track(new Promise(() => undefined));
    expect(await log.drain(30)).toBe(1);
    closeSync(fd);
  });
});

describe('the credentials taken out of what is recorded', () => {
  const secrets = hostSecrets({
    OPENAI_API_KEY: 'sk-test-0123456789',
    GEMINI_API_KEY: 'short',
    HTTPS_PROXY: 'http://me:pr0xy-passw0rd@proxy.example:8080',
    PATH: '/usr/bin',
  });

  test("are the host's secrets, of eight characters or more", () => {
    expect(secrets).toEqual([
      { value: 'sk-test-0123456789', what: 'provider key' },
      { value: 'pr0xy-passw0rd', what: "password of the host's proxy" },
    ]);
    expect(redactExact('key sk-test-0123456789 and short', secrets)).toBe(
      'key [removed: provider key] and short',
    );
  });

  test('and, in arguments, what the patterns recognize', () => {
    const cases: [string, string][] = [
      [
        "curl -H 'Authorization: Bearer abc.def' x",
        "curl -H 'Authorization: [removed: Authorization value]' x",
      ],
      [
        'Proxy-Authorization: Basic Zm9v',
        'Proxy-Authorization: [removed: Proxy-Authorization value]',
      ],
      [
        'git clone https://user:hunter22@git.example/r',
        'git clone https://user:[removed: password in URL]@git.example/r',
      ],
      [
        'tool --password s3cret --token=abc',
        'tool --password [removed: value of --password] --token=[removed: value of --token]',
      ],
      ["tool --api-key 'k e y'", 'tool --api-key [removed: value of --api-key]'],
      ['curl -u admin:letmein https://a', 'curl -u admin:[removed: password] https://a'],
      [
        'curl "https://a/?user=x&token=t0k3n&b=1"',
        'curl "https://a/?user=x&token=[removed: value of token]&b=1"',
      ],
      ['nmap -p 80,443 -sV 203.0.113.5', 'nmap -p 80,443 -sV 203.0.113.5'],
    ];
    for (const [given, expected] of cases) expect(redactText(given, secrets)).toBe(expected);
  });

  test('in every string of the arguments, nested ones included', () => {
    expect(
      redactStrings(
        { command: 'echo sk-test-0123456789', list: ['--secret x', 3], nested: { a: null } },
        (text) => redactText(text, secrets),
      ),
    ).toEqual({
      command: 'echo [removed: provider key]',
      list: ['--secret [removed: value of --secret]', 3],
      nested: { a: null },
    });
  });
});

// A log written as the host writes one, with the engagement's copy beside it.
const session = (entries: EvidenceEntry[], engagement = '{"scope":{}}') => {
  const path = join(scratch(), '20261120T120000Z-1.jsonl');
  const companion = companionOf(path);
  mkdirSync(companion);
  writeFileSync(join(companion, 'engagement.json'), engagement);
  const fd = openSync(path, 'wx', 0o600);
  const log = new EvidenceLog({ fd, onFailure: () => undefined });
  log.append({ type: 'session.started', engagement: { sha256: sha256(engagement) } });
  for (const entry of entries) log.append(entry);
  closeSync(fd);
  return { path, companion, finalHash: log.lastHash };
};

const copy = (companion: string, name: string, content: string) => {
  writeFileSync(join(companion, name), content);
  return { name, bytes: Buffer.byteLength(content), sha256: sha256(content) };
};

describe('the verification of an evidence log', () => {
  test('finds a whole session complete, and its final hash the one expected', () => {
    const output = { name: 'c1-stdout.1.txt', bytes: 10, sha256: sha256('the output') };
    const {
      path: full,
      companion,
      finalHash,
    } = session([
      { type: 'tool.started', callId: 'c1' },
      {
        type: 'tool.finished',
        callId: 'c1',
        outputs: [
          {
            stream: 'stdout',
            preservation: 'parts',
            copies: [output],
            copiedSha256: sha256('the output'),
            matchesSaved: true,
          },
        ],
      },
      { type: 'session.ended' },
    ]);
    copy(companion, 'c1-stdout.1.txt', 'the output');
    expect(verifyEvidence(full)).toEqual({
      status: 'complete',
      entries: 4,
      finalHash,
      reasons: [],
      anchored: false,
    });
    expect(verifyEvidence(full, finalHash).status).toBe('complete');
    expect(verifyEvidence(full, ZERO_HASH)).toMatchObject({
      status: 'corrupted',
      reasons: [`the final hash is ${finalHash}, not the one expected, ${ZERO_HASH}`],
    });
  });

  test('finds an entry edited, removed or the chain recomputed', () => {
    const entries: EvidenceEntry[] = [
      { type: 'tool.started', callId: 'c1', arguments: { command: 'id' } },
      { type: 'tool.finished', callId: 'c1' },
      { type: 'session.ended' },
    ];
    const { path, finalHash } = session(entries);
    const written = lines(path);
    writeFileSync(
      path,
      `${[written[0], written[1]?.replace('"id"', '"whoami"'), written[2], written[3]].join('\n')}\n`,
    );
    expect(verifyEvidence(path).reasons).toEqual([
      'entry 3 does not hold the hash of the one before',
    ]);
    writeFileSync(path, `${[written[0], written[2], written[3]].join('\n')}\n`);
    expect(verifyEvidence(path).reasons).toEqual(['entry 2 is out of sequence']);
    // Rewritten whole, its hashes worked out again: only the hash kept elsewhere tells.
    const forged = session([
      { type: 'tool.started', callId: 'c1', arguments: { command: 'whoami' } },
      ...entries.slice(1),
    ]);
    expect(verifyEvidence(forged.path).status).toBe('complete');
    expect(verifyEvidence(forged.path, finalHash).status).toBe('corrupted');
  });

  test('tells a session cut short from a corrupted one', () => {
    const open = session([{ type: 'tool.started', callId: 'c1' }]);
    expect(verifyEvidence(open.path)).toMatchObject({
      status: 'incomplete',
      reasons: ['the session has no end recorded', 'calls started without an outcome recorded: c1'],
    });
    writeFileSync(open.path, `${readFileSync(open.path, 'utf8')}{"seq":3,"at`);
    expect(verifyEvidence(open.path).reasons[0]).toBe(
      'the last line is cut short: the session ended while writing it',
    );
    const refused = session([
      { type: 'tool.started', callId: 'c1' },
      { type: 'tool.refused', callId: 'c1', started: true },
      { type: 'tool.refused', callId: 'c2', started: false },
      { type: 'session.ended' },
    ]);
    expect(verifyEvidence(refused.path).status).toBe('complete');
  });

  test('finds transitions that cannot be', () => {
    const cases: [EvidenceEntry[], string][] = [
      [
        [{ type: 'tool.finished', callId: 'c1' }],
        'entry 2 ends a call that was not started, or ended already',
      ],
      [
        [
          { type: 'tool.started', callId: 'c1' },
          { type: 'tool.started', callId: 'c1' },
        ],
        'entry 3 reuses a call id',
      ],
      [
        [{ type: 'job.started', jobId: 'j1', callId: 'c9' }],
        'entry 2 starts a job for a call that was not started',
      ],
      [
        [
          { type: 'tool.started', callId: 'c1' },
          { type: 'job.started', jobId: 'j1', callId: 'c1' },
          { type: 'job.finished', jobId: 'j1', log: {} },
          { type: 'job.finished', jobId: 'j1', log: {} },
        ],
        'entry 5 ends job j1, which was not started, or ended already',
      ],
      [
        [{ type: 'session.ended' }, { type: 'tool.started', callId: 'c1' }],
        'entry 3 comes after the end of the session',
      ],
      [
        [{ type: 'tool.refused', callId: 'c1', started: true }],
        'entry 2 refuses a call that was not started, or ended already',
      ],
    ];
    for (const [entries, reason] of cases) {
      expect(verifyEvidence(session(entries).path)).toMatchObject({
        status: 'corrupted',
        reasons: [reason],
      });
    }
  });

  test('reads a copy only beside the log, by name, and never through a link', () => {
    const outside = join(scratch(), 'outside.txt');
    writeFileSync(outside, 'not evidence');
    const finished = (name: string): EvidenceEntry[] => [
      { type: 'tool.started', callId: 'c1' },
      {
        type: 'tool.finished',
        callId: 'c1',
        outputs: [{ copies: [{ name, bytes: 12, sha256: sha256('not evidence') }] }],
      },
      { type: 'session.ended' },
    ];
    for (const name of ['../outside.txt', outside, 'c1-stdout.1.txt/..']) {
      expect(verifyEvidence(session(finished(name)).path).reasons).toEqual([
        `entry 3: "${name}" is not a copy's name`,
      ]);
    }
    const linked = session(finished('c1-stdout.1.txt'));
    symlinkSync(outside, join(linked.companion, 'c1-stdout.1.txt'));
    expect(verifyEvidence(linked.path).reasons[0]).toStartWith(
      'entry 3: c1-stdout.1.txt cannot be opened',
    );
    const altered = session(finished('c1-stdout.1.txt'));
    writeFileSync(join(altered.companion, 'c1-stdout.1.txt'), 'not evidencf');
    expect(verifyEvidence(altered.path).reasons).toEqual([
      'entry 3: the copy c1-stdout.1.txt is not what was copied',
    ]);
  });

  test('finds outputs not wholly preserved, and an engagement copy that is not the one read', () => {
    const partial = session([
      { type: 'tool.started', callId: 'c1' },
      {
        type: 'tool.finished',
        callId: 'c1',
        outputs: [
          { preservation: 'parts', matchesSaved: false },
          { preservation: 'omitted', omitted: 'the copies reached their limit of 2 GiB' },
          {
            preservation: 'parts',
            complete: false,
            stopReason: 'the 64MB limit per output was reached',
            matchesSaved: true,
          },
        ],
      },
      { type: 'session.ended' },
    ]);
    expect(verifyEvidence(partial.path)).toMatchObject({
      status: 'incomplete',
      reasons: [
        'entry 3: a copy differs from what the worker saved, which a command could have rewritten before it was copied',
        'entry 3: an output was not preserved: the copies reached their limit of 2 GiB',
        'entry 3: an output was not saved whole: the 64MB limit per output was reached',
      ],
    });
    const swapped = session([{ type: 'session.ended' }]);
    writeFileSync(join(swapped.companion, 'engagement.json'), '{"scope":{"allow":[]}}');
    expect(verifyEvidence(swapped.path).reasons).toEqual([
      "the engagement's copy is not the file the session read",
    ]);
  });
});
