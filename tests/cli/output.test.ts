import { describe, expect, test } from 'bun:test';
import { createJsonSink, createPlainSink, NDJSON_VERSION } from '../../src/cli/output.ts';

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

  test('the NDJSON output carries a notice as an event', () => {
    const lines: string[] = [];
    createJsonSink((line) => lines.push(line)).event({ type: 'notice', text: 'n' });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { v: NDJSON_VERSION, type: 'notice', text: 'n' },
    ]);
  });
});
