// Minimal terminal model for screen tests. It interprets the subset of output the screen
// engine emits (printable text, CR, LF, CSI cursor movement, erase, SGR, private modes) and
// keeps a visible grid plus a scrollback. LF also returns to column 0, as a TTY with ONLCR
// does (raw mode keeps output post-processing on). Text must be single-width characters.
//
// `resize` models a reflowing terminal: on a shrink, rows longer than the new width wrap onto
// several rows, and rows that no longer fit move into the scrollback.

export interface VirtualTerminal {
  write: (s: string) => void;
  resize: (cols: number, rows: number) => void;
  // Visible rows with trailing spaces removed.
  screen: () => string[];
  scrollback: () => string[];
  cursor: () => { row: number; col: number };
  cursorVisible: () => boolean;
}

export const createVirtualTerminal = (
  initialCols: number,
  initialRows: number,
): VirtualTerminal => {
  let cols = initialCols;
  let rows = initialRows;
  const blankRow = (): string[] => Array.from({ length: cols }, () => ' ');
  const toRow = (text: string): string[] => {
    const cells = blankRow();
    [...text].slice(0, cols).forEach((ch, i) => {
      cells[i] = ch;
    });
    return cells;
  };
  const textOf = (cells: readonly string[]): string => cells.join('').replace(/ +$/, '');
  let grid: string[][] = Array.from({ length: rows }, blankRow);
  const history: string[] = [];
  let r = 0;
  let c = 0;
  let pendingWrap = false;
  let visible = true;

  const rowAt = (index: number): string[] => {
    const row = grid[index];
    if (row === undefined) throw new Error(`row ${index} outside the screen`);
    return row;
  };

  const lineFeed = (): void => {
    if (r === rows - 1) {
      history.push(textOf(grid.shift() ?? []));
      grid.push(blankRow());
    } else {
      r++;
    }
  };

  const put = (ch: string): void => {
    if (pendingWrap) {
      pendingWrap = false;
      c = 0;
      lineFeed();
    }
    rowAt(r)[c] = ch;
    if (c === cols - 1) pendingWrap = true;
    else c++;
  };

  const csi = (params: string, final: string): void => {
    if (params.startsWith('?')) {
      if (params === '?25') visible = final === 'h';
      return;
    }
    if (params.startsWith('>')) return;
    const n = params === '' ? 1 : Number.parseInt(params, 10);
    switch (final) {
      case 'A':
        r = Math.max(0, r - n);
        pendingWrap = false;
        return;
      case 'B':
        r = Math.min(rows - 1, r + n);
        pendingWrap = false;
        return;
      case 'C':
        c = Math.min(cols - 1, c + n);
        pendingWrap = false;
        return;
      case 'D':
        c = Math.max(0, c - n);
        pendingWrap = false;
        return;
      case 'H': {
        const [row, col] = params.split(';');
        r = Math.max(0, (Number.parseInt(row ?? '', 10) || 1) - 1);
        c = Math.max(0, (Number.parseInt(col ?? '', 10) || 1) - 1);
        pendingWrap = false;
        return;
      }
      case 'J':
        if (params === '2') {
          grid = Array.from({ length: rows }, blankRow);
          return;
        }
        if (params !== '' && params !== '0') throw new Error(`unsupported erase CSI ${params}J`);
        for (let i = c; i < cols; i++) rowAt(r)[i] = ' ';
        for (let i = r + 1; i < rows; i++) grid[i] = blankRow();
        return;
      case 'K':
        if (params !== '2') throw new Error(`unsupported erase CSI ${params}K`);
        grid[r] = blankRow();
        return;
      case 'm':
        return;
      default:
        throw new Error(`unsupported CSI ${params}${final}`);
    }
  };

  return {
    write: (s) => {
      let i = 0;
      while (i < s.length) {
        const ch = s[i] ?? '';
        if (ch === '\x1b') {
          if (s[i + 1] !== '[') throw new Error(`unsupported escape at ${i}`);
          let j = i + 2;
          while (j < s.length) {
            const code = s.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j++;
          }
          csi(s.slice(i + 2, j), s[j] ?? '');
          i = j + 1;
          continue;
        }
        if (ch === '\r') {
          c = 0;
          pendingWrap = false;
        } else if (ch === '\n') {
          c = 0;
          pendingWrap = false;
          lineFeed();
        } else {
          put(ch);
        }
        i++;
      }
    },
    resize: (newCols, newRows) => {
      const out: string[] = [];
      let cursorRow = 0;
      let cursorCol = c;
      grid.forEach((cells, index) => {
        const text = textOf(cells);
        if (index === r) {
          cursorRow = out.length + Math.floor(c / newCols);
          cursorCol = c % newCols;
        }
        if (text.length <= newCols) out.push(text);
        else for (let k = 0; k < text.length; k += newCols) out.push(text.slice(k, k + newCols));
      });
      while (out.length > newRows && out.length - 1 > cursorRow && out[out.length - 1] === '') {
        out.pop();
      }
      while (out.length > newRows) {
        history.push(out.shift() ?? '');
        cursorRow--;
      }
      cols = newCols;
      rows = newRows;
      grid = out.map(toRow);
      while (grid.length < rows) grid.push(blankRow());
      r = Math.max(0, cursorRow);
      c = Math.min(cursorCol, cols - 1);
      pendingWrap = false;
    },
    screen: () => grid.map(textOf),
    scrollback: () => [...history],
    cursor: () => ({ row: r, col: c }),
    cursorVisible: () => visible,
  };
};
