import type { UsageInfo } from './types.ts';

export const emptyUsage = (): UsageInfo => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
});

export const addUsage = (a: UsageInfo, b: UsageInfo): UsageInfo => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_creation: a.cache_creation + b.cache_creation,
});
