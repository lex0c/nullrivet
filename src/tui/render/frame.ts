// Left margin shared by every element except the input box, which stays at column 0 so the
// typing surface stands out and the cursor lands at column 2, aligned with the content above.
// The margin is plain spaces, so SGR attributes inside the content keep clean boundaries.

import type { Capabilities } from '../term.ts';

export const FRAME_MARGIN = '  ';
export const FRAME_MARGIN_WIDTH = FRAME_MARGIN.length;

export const frameWidth = (caps: Capabilities): number =>
  Math.max(0, caps.cols - FRAME_MARGIN_WIDTH);

export const padFrame = (line: string): string => `${FRAME_MARGIN}${line}`;
