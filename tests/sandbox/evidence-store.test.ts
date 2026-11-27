import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/sandbox/evidence.ts';
import { EvidenceRecorder } from '../../src/sandbox/evidence-recorder.ts';
import { type EvidenceStore, openEvidenceStore } from '../../src/sandbox/evidence-store.ts';

const dirs: string[] = [];
const stores: EvidenceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-store-')));
  dirs.push(dir);
  return dir;
};

const open = (dir: string, forbidden: string[] = []) => {
  const store = openEvidenceStore({
    dir,
    forbidden,
    engagementBytes: Buffer.from('{"scope":{}}'),
    onFailure: () => undefined,
    now: () => new Date('2026-11-20T12:00:00.123Z'),
  });
  if (!('error' in store)) stores.push(store);
  return store;
};

describe('the evidence directory', () => {
  test('is made private, with the engagement file kept and the log beside it', () => {
    const base = scratch();
    const store = open(join(base, 'evidence'));
    if ('error' in store) throw new Error(store.error);
    expect(statSync(join(base, 'evidence')).mode & 0o777).toBe(0o700);
    const name = `20261120T120000Z-${process.pid}`;
    expect(readdirSync(join(base, 'evidence')).sort()).toEqual([name, `${name}.jsonl`]);
    expect(store.path).toBe(join(base, 'evidence', `${name}.jsonl`));
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    const kept = readFileSync(join(base, 'evidence', name, 'engagement.json'));
    expect(sha256(kept)).toBe(sha256('{"scope":{}}'));
    // A second session in the same second gets names of its own.
    const second = open(join(base, 'evidence'));
    expect('error' in second ? second.error : second.path).toEndWith(`${name}-2.jsonl`);
  });

  test('is refused inside what the sandbox sees, by its real path', () => {
    const base = scratch();
    const project = join(base, 'project');
    mkdirSync(project);
    const inside = open(join(project, 'evidence'), [project]);
    expect('error' in inside ? inside.error : 'opened').toBe(
      `the evidence directory ${join(project, 'evidence')}: it is inside ${project}, which the sandbox sees`,
    );
    // Through a link to the project, the real path is the project's.
    symlinkSync(project, join(base, 'link'));
    const through = open(join(base, 'link', 'evidence'), [project]);
    expect('error' in through ? through.error : 'opened').toContain(`it is inside ${project}`);
  });

  test('is refused as a link, or writable by others than its owner', () => {
    const base = scratch();
    mkdirSync(join(base, 'real'), { mode: 0o700 });
    symlinkSync(join(base, 'real'), join(base, 'evidence'));
    const linked = open(join(base, 'evidence'));
    expect('error' in linked ? linked.error : 'opened').toStartWith(
      `the evidence directory ${join(base, 'evidence')}: `,
    );
    mkdirSync(join(base, 'shared'));
    chmodSync(join(base, 'shared'), 0o777);
    const shared = open(join(base, 'shared'));
    expect('error' in shared ? shared.error : 'opened').toBe(
      `the evidence directory ${join(base, 'shared')}: others than its owner can write to it`,
    );
  });
});

describe('the end of a session that never started', () => {
  test('writes nothing: an end alone would read as a corrupted log', async () => {
    const store = open(join(scratch(), 'evidence'));
    if ('error' in store) throw new Error(store.error);
    stores.splice(stores.indexOf(store), 1);
    const summary = await new EvidenceRecorder(store).close({ outcome: 'not started' });
    expect(summary.entries).toBe(0);
    expect(readFileSync(store.path, 'utf8')).toBe('');
  });
});

describe("the record of the proxy's decisions", () => {
  test('keeps twenty refusals a second one by one, and counts the rest, written at the end too', async () => {
    const base = scratch();
    const store = open(join(base, 'evidence'));
    if ('error' in store) throw new Error(store.error);
    stores.splice(stores.indexOf(store), 1);
    const at = { now: new Date('2026-11-20T12:00:00.100Z') };
    const recorder = new EvidenceRecorder(store, () => at.now);
    recorder.sessionStarted({});
    for (let refusal = 0; refusal < 25; refusal += 1) {
      recorder.proxy({ type: 'refused', reason: `refusal ${refusal}` });
    }
    recorder.proxy({ type: 'authorized', host: 'app.test', port: 443, address: '198.51.100.7' });
    await recorder.close();
    const types = readFileSync(store.path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; count?: number });
    expect(types.filter((entry) => entry.type === 'proxy.refused')).toHaveLength(20);
    expect(types.find((entry) => entry.type === 'proxy.refused.omitted')?.count).toBe(5);
    expect(types.filter((entry) => entry.type === 'proxy.authorized')).toHaveLength(1);
    expect(types.at(-1)?.type).toBe('session.ended');
  });
});
