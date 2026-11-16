// Compact token count for status lines: 999, 1.2k, 57k, 1.5M.
export const formatTokens = (n: number): string => {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};
