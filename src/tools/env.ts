// Credentials used by the agent itself. Removing them from child process environments keeps a
// command produced by prompt injection from reading and exfiltrating them.
export const AGENT_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'OLLAMA_API_KEY',
  // Never read by nullrivet, but a credential of the same account.
  'ANTHROPIC_AUTH_TOKEN',
]);

export const scrubAgentEnv = (
  base: Record<string, string | undefined>,
  extraExcluded: readonly string[] = [],
): Record<string, string> => {
  const excluded = new Set(extraExcluded);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || excluded.has(key)) continue;
    if (AGENT_SECRET_ENV_KEYS.has(key) || key.startsWith('NULLRIVET_')) continue;
    env[key] = value;
  }
  return env;
};
