import { describe, expect, test } from 'bun:test';
import { parseCli, parseDuration, UsageError } from '../../src/cli/args.ts';

describe('parseDuration', () => {
  test('accepts seconds, minutes and hours', () => {
    expect(parseDuration('90s', '--timeout')).toBe(90_000);
    expect(parseDuration('30m', '--timeout')).toBe(1_800_000);
    expect(parseDuration('2h', '--timeout')).toBe(7_200_000);
    expect(parseDuration('45', '--timeout')).toBe(45_000);
    expect(parseDuration('596h', '--timeout')).toBe(596 * 3_600_000);
    expect(parseDuration(undefined, '--timeout')).toBeUndefined();
  });

  test('refuses anything else', () => {
    for (const value of ['0', '-5', '1.5h', '10d', 'soon', '5 m', '597h']) {
      expect(() => parseDuration(value, '--timeout')).toThrow(UsageError);
    }
  });
});

describe('--timeout', () => {
  test('the flag takes precedence over the environment', () => {
    expect(
      parseCli(['--timeout', '10m', 'go'], { NULLRIVET_TIMEOUT: '1h' }, '/tmp').timeLimitMs,
    ).toBe(600_000);
    expect(parseCli(['go'], { NULLRIVET_TIMEOUT: '1h' }, '/tmp').timeLimitMs).toBe(3_600_000);
    expect(parseCli(['go'], {}, '/tmp').timeLimitMs).toBeUndefined();
  });
});
