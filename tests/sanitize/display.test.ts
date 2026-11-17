import { describe, expect, test } from 'bun:test';
import { terminalText } from '../../src/sanitize/display.ts';

describe('terminalText', () => {
  test('removes escape sequences, control bytes and carriage returns, and keeps tabs and newlines', () => {
    expect(terminalText('a\x1b[31mb\x1b[0m\r\x07c\td\ne')).toBe('abc\td\ne');
  });

  test('removes bidirectional embeddings, overrides and isolates', () => {
    const controls = [
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];
    expect(terminalText(`if (a${controls.join('')}b)`)).toBe('if (ab)');
  });

  test('keeps right-to-left text, which is not a control', () => {
    expect(terminalText('שלום مرحبا')).toBe('שלום مرحبا');
  });
});
