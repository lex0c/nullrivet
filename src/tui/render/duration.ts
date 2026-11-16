// Duration formatting for operation chips:
//   < 1s    → `850ms`
//   < 1min  → `8.2s`   one decimal, the precision wanted while a chip ticks live
//   ≥ 1min  → `1m23s`  (`2m` when the seconds are zero)
// A negative input (clock skew between producer and renderer) clamps to `0ms`, keeping the
// sub-second unit so one skewed tick does not flip the chip between units.
export const formatChipDuration = (ms: number): string => {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  // Branch on the value rounded to tenths; comparing raw ms would render 59 999ms as `60.0s`.
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  // Rounding `tenths` again would double-round (60 450ms → `1m1s` instead of `1m`).
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
};

// Whole-second variant for prose-like lines (`Worked for 8s`), where a decimal reads as
// noise. Same shape as `formatChipDuration` outside the 1s–1min band. Callers pass a
// non-negative value.
export const formatCoarseDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
};
