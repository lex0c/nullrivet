// Verb pools for the live chips of the three phases of a turn: thinking (cognitive verbs),
// streaming text (output verbs) and running tools (orchestration verbs). The pools are kept
// apart so the label also tells the operator which phase is running.
//
// Selection hashes a stable per-turn seed (the assistant message id) into the pool: the verb
// stays the same on every frame of a turn and varies across turns. Pools are small on purpose;
// a large pool makes the label read as noise.

const COGNITIVE_VERBS = [
  'Modeling',
  'Synthesizing',
  'Deriving',
  'Correlating',
  'Evaluating',
] as const;

const OUTPUT_VERBS = ['Forging', 'Tempering', 'Hardening', 'Smelting', 'Shaping'] as const;

const TOOL_VERBS = [
  'Orchestrating',
  'Dispatching',
  'Sequencing',
  'Coordinating',
  'Consolidating',
] as const;

// Non-cryptographic string hash folded into [0, mod). `| 0` keeps the running value a 32-bit
// integer; the final fold yields a non-negative uint32 without the INT_MIN corner case of
// `Math.abs`.
const hashIndex = (seed: string, mod: number): number => {
  if (mod <= 0) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return ((h ^ (h >>> 31)) >>> 0) % mod;
};

// Per-pool salts. The pools have the same size, so without a salt the same seed would pick
// the same index in each and the verbs of a turn would always come in the same pairs.
const COGNITIVE_SALT = 'cog';
const OUTPUT_SALT = 'out';
const TOOL_SALT = 'tool';

export const pickCognitiveVerb = (seed: string): string => {
  const i = hashIndex(COGNITIVE_SALT + seed, COGNITIVE_VERBS.length);
  return COGNITIVE_VERBS[i] ?? COGNITIVE_VERBS[0];
};

export const pickOutputVerb = (seed: string): string => {
  const i = hashIndex(OUTPUT_SALT + seed, OUTPUT_VERBS.length);
  return OUTPUT_VERBS[i] ?? OUTPUT_VERBS[0];
};

export const pickToolVerb = (seed: string): string => {
  const i = hashIndex(TOOL_SALT + seed, TOOL_VERBS.length);
  return TOOL_VERBS[i] ?? TOOL_VERBS[0];
};

// Exposed for tests that pin the pool contents. Production code uses the pickers.
export const COGNITIVE_VERB_POOL: ReadonlyArray<string> = COGNITIVE_VERBS;
export const OUTPUT_VERB_POOL: ReadonlyArray<string> = OUTPUT_VERBS;
export const TOOL_VERB_POOL: ReadonlyArray<string> = TOOL_VERBS;
