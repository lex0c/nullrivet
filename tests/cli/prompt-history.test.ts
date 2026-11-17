import { describe, expect, test } from 'bun:test';
import { PromptHistory } from '../../src/cli/prompt-history.ts';

describe('PromptHistory', () => {
  test('↑ walks back to the oldest entry and stays there', () => {
    const history = new PromptHistory(['one', 'two', 'three']);
    expect(history.previous('')).toBe('three');
    expect(history.previous('three')).toBe('two');
    expect(history.previous('two')).toBe('one');
    expect(history.previous('one')).toBe('one');
  });

  test('↓ past the newest entry brings back the draft', () => {
    const history = new PromptHistory(['one', 'two']);
    expect(history.next()).toBeNull();
    history.previous('half-typed');
    history.previous('two');
    expect(history.next()).toBe('two');
    expect(history.next()).toBe('half-typed');
    expect(history.browsing).toBe(false);
    expect(history.next()).toBeNull();
  });

  test('an empty history recalls nothing', () => {
    const history = new PromptHistory();
    expect(history.previous('draft')).toBeNull();
    expect(history.browsing).toBe(false);
  });

  test('editing a recalled entry starts again from the newest one', () => {
    const history = new PromptHistory(['one', 'two']);
    history.previous('');
    history.previous('two');
    history.stopBrowsing();
    expect(history.previous('one, edited')).toBe('two');
    history.next();
    expect(history.next()).toBeNull();
  });

  test('blank text and a repeat of the latest entry are not added', () => {
    const history = new PromptHistory();
    history.add('run the tests');
    history.add('run the tests');
    history.add('   ');
    history.add('/stats');
    history.add('run the tests');
    expect(history.entries()).toEqual(['run the tests', '/stats', 'run the tests']);
    expect(history.revision).toBe(3);
  });

  test('adding ends browsing and keeps only the newest entries', () => {
    const history = new PromptHistory(['a', 'b', 'c'], { entries: 3 });
    expect(history.entries()).toEqual(['a', 'b', 'c']);
    history.previous('');
    history.add('d');
    expect(history.browsing).toBe(false);
    expect(history.entries()).toEqual(['b', 'c', 'd']);
    expect(new PromptHistory(['a', 'b', 'c', 'd'], { entries: 2 }).entries()).toEqual(['c', 'd']);
  });

  test('a text over the entry limit is not kept, and the oldest entries go past the total', () => {
    const history = new PromptHistory([], { bytes: 10, entryBytes: 6 });
    history.add('é'.repeat(4));
    expect(history.entries()).toEqual([]);
    expect(history.revision).toBe(0);
    history.add('aaaa');
    history.add('bbbb');
    history.add('cccc');
    expect(history.entries()).toEqual(['bbbb', 'cccc']);
  });

  test('entries loaded from a session file are held to the same limits', () => {
    const loaded = new PromptHistory(['x'.repeat(7), 'aaaa', 'bbbb', 'cccc'], {
      bytes: 10,
      entryBytes: 6,
    });
    expect(loaded.entries()).toEqual(['bbbb', 'cccc']);
  });
});
