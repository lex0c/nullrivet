import { describe, expect, test } from 'bun:test';
import { stripAnsi } from '../../src/sanitize/ansi.ts';

describe('stripAnsi', () => {
  test('removes control sequences and keeps the text', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('a\x1b]0;title\x07b')).toBe('ab');
    expect(stripAnsi('a\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\b')).toBe('alinkb');
    expect(stripAnsi('a\x1bPq#0\x1b\\b')).toBe('ab');
    expect(stripAnsi('tab\tline\nret\r')).toBe('tab\tline\nret\r');
  });

  test('an unterminated string loses its escape, so nothing reaches the terminal', () => {
    const out = stripAnsi('a\x1b]0;title never ends');
    expect(out).not.toContain('\x1b');
    expect(out.startsWith('a')).toBe(true);
  });

  test('adversarial input is processed in linear time', () => {
    for (const unit of ['\x1b]', '\x1bP', '\x1b_', '\x1b[']) {
      const started = performance.now();
      expect(stripAnsi(unit.repeat(128 * 1024))).not.toContain('\x1b');
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
