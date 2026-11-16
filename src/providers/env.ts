export type Env = Readonly<Record<string, string | undefined>>;

// One shared vocabulary for feature flags, so two flags never disagree on whether `yes` counts.
// Unset or empty yields the fallback; any other value is ON only for 1/true/yes/on.
export const boolFromEnv = (env: Env, name: string, fallback = false): boolean => {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const norm = v.toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on';
};
