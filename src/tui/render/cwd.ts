// Display form of the working directory. `$HOME` collapses to `~`; a path still longer than
// the budget keeps its leading context and its last two components, with an ellipsis for the
// middle (e.g. a removable-drive mount `/run/media/<user>/<uuid>/...`, whose middle carries
// no information). Only the display string is shortened.

import type { Capabilities } from '../term.ts';
import { ellipsisGlyph } from './glyphs.ts';

// A readability budget, not the terminal width: a mount path can fit 80 columns and still be
// unreadable. The live region still truncates to the terminal width.
const CWD_BUDGET = 48;
// Leading components kept for an absolute path (`/run/media`, `/usr/local`).
const HEAD_KEEP_ABS = 2;
// The repository and its parent directory.
const TAIL_KEEP = 2;

// Anchored on the path boundary, so `/home/lexicon` under home `/home/lex` is left alone.
const collapseHome = (path: string, home: string): string => {
  if (home.length === 0) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
};

export const shortenCwd = (cwd: string, home: string, caps: Capabilities): string => {
  const collapsed = collapseHome(cwd, home);
  if (collapsed.length <= CWD_BUDGET) return collapsed;

  const isHome = collapsed === '~' || collapsed.startsWith('~/');
  const isAbs = collapsed.startsWith('/');
  const rest = isHome ? collapsed.slice(2) : isAbs ? collapsed.slice(1) : collapsed;
  const comps = rest.split('/').filter((c) => c.length > 0);

  // `~` already says where a home path lives, so it keeps no leading components.
  const headKeep = isHome ? 0 : HEAD_KEEP_ABS;
  if (comps.length <= headKeep + TAIL_KEEP) return collapsed;

  const middle = [
    ...comps.slice(0, headKeep),
    ellipsisGlyph(caps),
    ...comps.slice(comps.length - TAIL_KEEP),
  ].join('/');
  if (isHome) return `~/${middle}`;
  if (isAbs) return `/${middle}`;
  return middle;
};
