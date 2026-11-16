import { describe, expect, test } from 'bun:test';
import { splitSettledMarkdown } from '../../src/tui/markdown-stream.ts';

describe('splitSettledMarkdown', () => {
  test('nothing settles until a blank line is followed by a new block', () => {
    expect(splitSettledMarkdown('First paragraph')).toEqual({
      settled: '',
      pending: 'First paragraph',
    });
    expect(splitSettledMarkdown('First paragraph\n\n')).toEqual({
      settled: '',
      pending: 'First paragraph\n\n',
    });
    expect(splitSettledMarkdown('First paragraph\n\nSec')).toEqual({
      settled: 'First paragraph',
      pending: 'Sec',
    });
  });

  test('settles up to the last complete boundary', () => {
    const text = '# Title\n\nOne.\n\nTwo.\n\nThree is still';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: '# Title\n\nOne.\n\nTwo.',
      pending: 'Three is still',
    });
  });

  test('blank lines inside a fenced code block do not settle it', () => {
    const text = 'Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: 'Intro',
      pending: '```ts\nconst a = 1;\n\nconst b = 2;\n',
    });
  });

  test('a closed fence followed by a new block settles', () => {
    const text = '```\ncode\n\nmore\n```\n\nAfter';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: '```\ncode\n\nmore\n```',
      pending: 'After',
    });
  });

  test('a shorter or different fence does not close the open one', () => {
    const text = '````md\n```\n\ninner\n';
    expect(splitSettledMarkdown(text).settled).toBe('');
    const tilde = '~~~\n```\n\nstill code\n';
    expect(splitSettledMarkdown(tilde).settled).toBe('');
  });

  test('an indented continuation after a blank line stays with its block', () => {
    const text = '- item one\n\n  more about item one\n';
    expect(splitSettledMarkdown(text)).toEqual({ settled: '', pending: text });
  });

  test('settled and pending recompose the original blocks', () => {
    const text = 'a\n\nb\n\nc';
    const { settled, pending } = splitSettledMarkdown(text);
    expect(`${settled}\n\n${pending}`).toBe(text);
  });
});
