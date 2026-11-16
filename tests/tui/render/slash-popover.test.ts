import { describe, expect, test } from 'bun:test';
import {
  renderSlashPopover,
  type SlashSuggestions,
  slashPopoverLineCount,
} from '../../../src/tui/render/slash-popover.ts';
import { type Capabilities, CSI } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const colored: Capabilities = { ...caps, color: 'basic' };

const slash = (items: { name: string; description: string }[], selected = 0): SlashSuggestions => ({
  items,
  selected,
});

const many = (n: number): { name: string; description: string }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `cmd${i}`, description: `desc ${i}` }));

const sgrPrefix = new RegExp(`^${CSI.replace('[', '\\[')}[0-9;]+m`);

describe('renderSlashPopover', () => {
  test('colored terminals: every row starts at col 0 with no glyph (color carries selection)', () => {
    const out = renderSlashPopover(
      slash([
        { name: 'help', description: 'show help' },
        { name: 'quit', description: 'exit' },
      ]),
      colored,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.replace(sgrPrefix, '')).toMatch(/^\/help/);
    expect(out[1]?.replace(sgrPrefix, '')).toMatch(/^\/quit/);
  });

  test('no-color terminals: selected row gets `> `, unselected rows `  `', () => {
    // Without color the selected and unselected rows would look identical, and Enter runs
    // the selected command.
    const out = renderSlashPopover(
      slash([
        { name: 'help', description: 'show help' },
        { name: 'quit', description: 'exit' },
      ]),
      caps,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^> \/help/);
    expect(out[1]).toMatch(/^ {2}\/quit/);
  });

  test('no-color terminals: the glyph follows the selection', () => {
    const out = renderSlashPopover(
      slash(
        [
          { name: 'a', description: 'a' },
          { name: 'b', description: 'b' },
          { name: 'c', description: 'c' },
        ],
        2,
      ),
      caps,
    );
    expect(out[0]).toMatch(/^ {2}\/a/);
    expect(out[1]).toMatch(/^ {2}\/b/);
    expect(out[2]).toMatch(/^> \/c/);
  });

  test('names are padded to align descriptions', () => {
    const out = renderSlashPopover(
      slash([
        { name: 'x', description: 'desc-A' },
        { name: 'longer', description: 'desc-B' },
      ]),
      caps,
    );
    const idx0 = (out[0] ?? '').indexOf('desc-A');
    const idx1 = (out[1] ?? '').indexOf('desc-B');
    expect(idx0).toBe(idx1);
    expect(idx0).toBeGreaterThan(0);
  });

  test('shows a "(no matches)" row when there are no items', () => {
    const out = renderSlashPopover(slash([], -1), caps);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('(no matches');
  });

  test('caps visible items at 8 and adds a "(N more)" row when overflowing', () => {
    const out = renderSlashPopover(slash(many(10), 0), caps);
    expect(out).toHaveLength(9);
    expect(out[8]).toContain('(2 more');
  });

  test('the window slides so the selected row stays visible', () => {
    const out = renderSlashPopover(slash(many(10), 9), colored);
    expect(out).toHaveLength(9);
    const selectedRow = out.findIndex((l) => l.includes(`${CSI}94m`));
    expect(selectedRow).toBe(7);
    expect(out[selectedRow]).toContain('cmd9');
    expect(out[0]).toContain('cmd2');
  });

  test('selected row uses accent SGR; unselected rows use secondary', () => {
    const out = renderSlashPopover(
      slash(
        [
          { name: 'a', description: 'a' },
          { name: 'b', description: 'b' },
          { name: 'c', description: 'c' },
        ],
        1,
      ),
      colored,
    );
    expect(out[0]).toContain(`${CSI}90m`);
    expect(out[1]).toContain(`${CSI}94m`);
    expect(out[2]).toContain(`${CSI}90m`);
  });

  test('the no-matches row and the overflow row use secondary SGR', () => {
    expect(renderSlashPopover(slash([], -1), colored)[0]).toContain(`${CSI}90m`);
    const overflow = renderSlashPopover(slash(many(10), 0), colored);
    expect(overflow[8]).toContain(`${CSI}90m`);
    expect(overflow[8]).toContain('2 more');
  });
});

describe('slashPopoverLineCount', () => {
  test('1 line when there are no items', () => {
    expect(slashPopoverLineCount(slash([], -1))).toBe(1);
  });

  test('one line per item under the cap', () => {
    expect(slashPopoverLineCount(slash(many(3), 0))).toBe(3);
  });

  test('8 visible rows plus 1 overflow row past the cap', () => {
    expect(slashPopoverLineCount(slash(many(10), 0))).toBe(9);
  });

  test('matches the rendered length in every branch', () => {
    for (const s of [slash([], -1), slash(many(2), 0), slash(many(12), 0)]) {
      expect(slashPopoverLineCount(s)).toBe(renderSlashPopover(s, caps).length);
    }
  });
});
