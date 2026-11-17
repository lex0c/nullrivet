import { describe, expect, test } from 'bun:test';
import { createJsonSink, createPlainSink, NDJSON_VERSION } from '../../src/cli/output.ts';
import { lineDiff } from '../../src/tools/line-diff.ts';

describe('runtime notices in one-shot output', () => {
  test('the plain output shows a notice on stderr, without escape sequences', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sink = createPlainSink({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      color: false,
    });
    sink.event({ type: 'notice', text: 'Background job x \x1b[31mfailed\x1b[0m' });
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['› note: Background job x failed\n']);
  });

  test('the plain output shows the lines an edit or write changed', () => {
    const stderr: string[] = [];
    const sink = createPlainSink({
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      color: false,
    });
    const end = (meta: Record<string, unknown> | undefined, isError = false) =>
      sink.event({
        type: 'tool:end',
        id: 't',
        name: 'edit_file',
        content: 'x',
        isError,
        ...(meta === undefined ? {} : { meta }),
      });
    end({ diff: lineDiff('a\nb', 'a\nB\nC') });
    end({ diff: lineDiff('a', 'a') });
    end(undefined);
    end({ diff: lineDiff('a', 'b') }, true);
    expect(stderr).toEqual(['  +2 -1\n', '  ✗ x\n']);
  });

  test('the NDJSON output carries the counts of a diff, without the lines of the file', () => {
    const lines: string[] = [];
    const sink = createJsonSink((line) => lines.push(line));
    const end = (meta: Record<string, unknown>) =>
      sink.event({
        type: 'tool:end',
        id: 't',
        name: 'write_file',
        content: 'x',
        isError: false,
        meta,
      });
    end({ path: '/w/.env', diff: lineDiff('API_KEY=old\n', 'API_KEY=new\n') });
    end({ path: '/w/a', diff: { snippet: 'not a diff' } });
    end({ path: '/w/b' });
    expect(lines.join('')).not.toContain('API_KEY');
    expect(lines.map((line) => JSON.parse(line).meta)).toEqual([
      { path: '/w/.env', diff: { added: 1, removed: 1 } },
      { path: '/w/a' },
      { path: '/w/b' },
    ]);
  });

  test('the NDJSON output carries a notice as an event', () => {
    const lines: string[] = [];
    createJsonSink((line) => lines.push(line)).event({ type: 'notice', text: 'n' });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { v: NDJSON_VERSION, type: 'notice', text: 'n' },
    ]);
  });
});
