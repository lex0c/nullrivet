// Tool arguments are echoed back into every later request. Sorting object keys makes the same
// value always serialize to the same bytes, which keeps the remote prompt-cache prefix stable.
// Array order is meaningful and is preserved.

export const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortKeysDeep(src[key]);
    }
    return out;
  }
  return value;
};

export const stableStringify = (value: unknown): string => JSON.stringify(sortKeysDeep(value));

export const canonicalizeObject = (obj: Record<string, unknown>): Record<string, unknown> =>
  sortKeysDeep(obj) as Record<string, unknown>;
