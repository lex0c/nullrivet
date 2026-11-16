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
    const history = new PromptHistory(['a', 'b', 'c'], 3);
    expect(history.entries()).toEqual(['a', 'b', 'c']);
    history.previous('');
    history.add('d');
    expect(history.browsing).toBe(false);
    expect(history.entries()).toEqual(['b', 'c', 'd']);
    expect(new PromptHistory(['a', 'b', 'c', 'd'], 2).entries()).toEqual(['c', 'd']);
  });
});
