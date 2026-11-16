// A highlight that slides left to right across a live chip's label. The centre character is
// `accent`, its two neighbours use the default color and the rest keep the chip's base
// token, which is as close to a gradient as the 16-color palette allows. The position is
// derived from `now`, so the frame scheduler animates it.

import { type Capabilities, paint, type SgrToken } from '../term.ts';

// The centre advances one character every SPEED ms; GAP idle positions after the text add a
// pause between passes.
const SHIMMER_SPEED_MS = 90;
const SHIMMER_GAP = 6;

export const renderShimmer = (
  text: string,
  caps: Capabilities,
  now: number,
  base: SgrToken,
): string => {
  if (caps.color === 'none') return text;
  const chars = [...text];
  const cycle = chars.length + SHIMMER_GAP;
  const centre = Math.floor(now / SHIMMER_SPEED_MS) % cycle;
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const d = Math.abs(i - centre);
    if (d === 0) out += paint(caps, 'accent', ch);
    else if (d === 1) out += ch;
    else out += paint(caps, base, ch);
  }
  return out;
};
