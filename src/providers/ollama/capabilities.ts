import type { ProviderCapabilities } from '../types.ts';

// Curated Ollama models for agentic coding, keyed by the Ollama model name. Every entry supports
// native tool calling; other models resolve through discovery.
//
// `context_window` is the model's capacity. A local server allocates its KV cache for the
// requested `num_ctx` and truncates prompts above it silently, so the adapter caps `num_ctx` for
// local servers and reports that served window as the provider's context window.
//
// `supports_reasoning` marks models whose thinking is an on/off switch; `supports_reasoning_effort`
// marks models that take the low/medium/high levels instead.

const K32 = 32_768;
const K40 = 40_960;
const K128 = 131_072;
const K256 = 262_144;

// Served by a local Ollama server, which needs no API key.
export const OLLAMA_LOCAL_CAPS: Record<string, ProviderCapabilities> = {
  'qwen2.5-coder:7b': { context_window: K32, output_max_tokens: 8_192 },
  'qwen2.5-coder:14b': { context_window: K32, output_max_tokens: 8_192 },
  'qwen3:8b': { context_window: K40, output_max_tokens: 16_384, supports_reasoning: true },
  'qwen3:14b': { context_window: K40, output_max_tokens: 16_384, supports_reasoning: true },
  'llama3.1:8b': { context_window: K128, output_max_tokens: 8_192 },
  'mistral-nemo:12b': { context_window: K128, output_max_tokens: 8_192 },
};

// Served by Ollama Cloud, which needs OLLAMA_API_KEY. A remote host has no local memory limit, so
// the full window is requested, up to 256K: the host serves several models up to 1M, which is far
// past a coding session.
export const OLLAMA_CLOUD_CAPS: Record<string, ProviderCapabilities> = {
  'kimi-k3.1-pro': { context_window: K256, output_max_tokens: 32_768, supports_reasoning: true },
  'kimi-k2.7-code:cloud': {
    context_window: K256,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'glm-5.3': { context_window: K256, output_max_tokens: 32_768, supports_reasoning: true },
  'glm-5.2': { context_window: K256, output_max_tokens: 32_768, supports_reasoning: true },
  'deepseek-v4.1-flash': {
    context_window: K256,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'deepseek-v4-pro:cloud': {
    context_window: K256,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'minimax-m3.1-flash': {
    context_window: K256,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'mistral-large-4': { context_window: K256, output_max_tokens: 32_768, supports_reasoning: true },
  'mimo-v2.6-pro': { context_window: K256, output_max_tokens: 32_768, supports_reasoning: true },
  'nemotron-3-ultra': { context_window: K256, output_max_tokens: 32_768, supports_reasoning: true },
  'gpt-oss:120b': {
    context_window: K128,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
  'gpt-oss:20b': {
    context_window: K128,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
};
