# Models and providers

## Model ids

A model is selected as `<family>/<model>` with `--model` or `NULLRIVET_MODEL`. The family is the
text before the first `/`; the rest is the model name sent to the provider. OpenRouter names have
a vendor prefix of their own:

```
anthropic/claude-sonnet-5-5
openai/gpt-5.4
ollama/qwen3-coder:480b
openrouter/deepseek/deepseek-v4-flash
```

| Family | Status |
|---|---|
| `anthropic`, `openai`, `ollama`, `openrouter` | Supported. |
| `google`, `xai` | Planned; selecting them reports that the family is not supported yet. |

## Resolution

nullrivet has no catalog file and never writes one. The capabilities of a model (context window,
output limit, reasoning and sampling support) are resolved in this order:

1. **Compiled catalog.** Curated entries built into nullrivet. When the id is in the catalog, the
   entry is used as is and nothing else is consulted.
2. **Discovery.** For ids missing from the catalog, nullrivet asks the provider about the model,
   with a 5 s timeout, and keeps the answer in memory for the rest of the process:
   - Anthropic: `GET /v1/models/{model}` (with the API key);
   - OpenRouter: `GET /models`, the public listing (no key needed);
   - Ollama: `POST /api/show` on the server that serves the model;
   - OpenAI has no endpoint with this information, so only catalog models get exact values.
3. **Defaults.** When discovery is unavailable or fails, the model is accepted with a warning and
   conservative values: a 32,768-token window, 8,192 output tokens, no reasoning, and no sampling
   parameters.

A model the provider reports without tool calling is rejected, since the agent depends on it. A
model the provider says it does not have is an error rather than a fallback to defaults, so typos
fail early. Discovered output limits are capped at 32,768 tokens, like the catalog's, because a
larger limit only shrinks the room left for context.

`--context-window` and `--max-output` override the limits of whichever source was used.

### What the catalog stores

Only facts that belong to the API contract of a model id, which changes only when a provider
publishes a new id:

| Field | Meaning |
|---|---|
| `context_window` | Context window in tokens. |
| `output_max_tokens` | Output token limit. |
| `supports_sampling` | Whether `temperature` and `top_p` are accepted (absent means yes). |
| `supports_reasoning_effort` | Accepts a reasoning effort level. |
| `supports_reasoning` | Reasons behind an on/off switch, without levels. |
| `supports_adaptive_thinking`, `supports_effort_xhigh`, `max_thinking_budget` | Provider-specific reasoning details. |
| `cache_explicit_breakpoints` | Prompt caching needs explicit cache markers. |
| `extended_prompt_cache`, `extended_prompt_cache_24h_only` | Extended prompt-cache retention. |

Prices are deliberately not stored. They change without the model id changing, especially on
OpenRouter, where routing, promotions and free tiers shift, so a compiled price table would always
be stale. nullrivet reports token counts instead (see [Usage and cost](#usage-and-cost)).

The OpenRouter catalog lives in `src/providers/openrouter/capabilities.ts`. Its context windows are
the window served by the default-routed provider, which can be smaller than the model's headline
maximum.

### Discovery mapping

**Anthropic**

| Model field | Capability |
|---|---|
| `max_input_tokens` | `context_window` |
| `max_tokens` | `output_max_tokens` |
| `capabilities.thinking.types.adaptive` | `supports_adaptive_thinking` |
| `capabilities.thinking.types.enabled` (without adaptive) | `supports_reasoning` (manual budget) |
| `capabilities.effort`, `capabilities.effort.xhigh` | `supports_reasoning_effort`, `supports_effort_xhigh` |
| — | `supports_sampling: false`, because several thinking models cannot turn thinking off |

**Ollama**

| `/api/show` field | Capability |
|---|---|
| `model_info.<arch>.context_length` | `context_window` |
| `thinking` in `capabilities` | `supports_reasoning` |
| `tools` missing from `capabilities` | model rejected (servers that do not report capabilities are trusted) |

**OpenRouter**

| Listing field | Capability |
|---|---|
| smaller of `context_length` and `top_provider.context_length` | `context_window` |
| `top_provider.max_completion_tokens` (8,192 when absent), capped at the window | `output_max_tokens` |
| `reasoning` in `supported_parameters` | `supports_reasoning` |
| `temperature` missing from `supported_parameters` | `supports_sampling: false` |
| `tools` missing from `supported_parameters` | model rejected |

Effort levels are never inferred from the listing, because a level the model does not accept is
rejected by the API.

## Output limit per request

The output limit of a request starts at the smaller of the model's `output_max_tokens` and a
quarter of its context window, and shrinks as the conversation grows so that prompt and answer
always fit in the window. See [ARCHITECTURE.md](ARCHITECTURE.md#context-management).

## Reasoning effort

`--effort` (`low`, `medium`, `high`, `xhigh`, `max`) is translated per model:

- models with `supports_reasoning_effort` receive the level in the provider's own parameter
  (Anthropic `output_config.effort`, OpenAI and OpenRouter `reasoning.effort`); OpenAI's top level
  is `xhigh`, so `max` maps to it, and Anthropic models without `xhigh` get `high`;
- models with only `supports_reasoning` have reasoning switched on (Anthropic models with a manual
  budget get one sized from the level; Ollama `gpt-oss` gets low/medium/high);
- other models ignore it.

Without `--effort`, no effort is sent and the provider's default applies. Anthropic models with
adaptive thinking think by default.

## Anthropic

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | API key. Required. |
| `NULLRIVET_ANTHROPIC_BASE_URL` | Endpoint (default `https://api.anthropic.com`). |
| `NULLRIVET_ANTHROPIC_CACHE_TTL` | `1h` selects the one-hour prompt cache; anything else keeps the default five minutes. |
| `NULLRIVET_ANTHROPIC_THINKING` | `0` turns off adaptive thinking on models that allow it (default on). |
| `NULLRIVET_ANTHROPIC_REASONING_REPLAY` | Send signed thinking back on tool follow-ups (default on, adaptive models only). |

- **Prompt caching** places cache breakpoints after the system prompt, after the tool definitions
  and on the latest message, so each request reuses the prefix of the previous one.
- **Thinking** blocks are replayed unmodified on tool follow-ups, which the API requires when
  thinking precedes a tool call. They are dropped from the part of the conversation that is
  compacted.
- `ANTHROPIC_AUTH_TOKEN` is never read: only the API key above is sent.

## OpenAI

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | API key. Required. |
| `NULLRIVET_OPENAI_BASE_URL` | Endpoint (default `https://api.openai.com/v1`); also works with compatible servers. |
| `NULLRIVET_OPENAI_PROMPT_CACHE_RETENTION` | `in_memory` opts out of the 24-hour prompt cache on models that allow it. |
| `NULLRIVET_OPENAI_REASONING_REPLAY` | Send encrypted reasoning items back on tool follow-ups (default on). |
| `NULLRIVET_OPENAI_INCLUDE_USAGE` | `0` stops requesting usage in streams, for compatible servers that reject it. |

- Models that accept a reasoning effort use the Responses API (with `store: false`, so nothing is
  kept on OpenAI's side); the others use Chat Completions.
- A prompt cache key derived from the system prompt and the tools keeps requests on warm caches.
- `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are never read or sent.

## Ollama

| Variable | Description |
|---|---|
| `OLLAMA_API_KEY` | Key for Ollama Cloud (`https://ollama.com`). Not needed for a local server. |
| `NULLRIVET_OLLAMA_BASE_URL` | Server for every Ollama model, overriding the defaults below. |
| `NULLRIVET_OLLAMA_NUM_CTX` | Context window to request from a local server (default 32,768). |
| `NULLRIVET_OLLAMA_KEEP_ALIVE` | How long the server keeps the model loaded. |
| `NULLRIVET_OLLAMA_REASONING_REPLAY` | Send the model's thinking back on tool follow-ups (default on). |

- Catalog models marked as cloud models are served from `https://ollama.com`; every other model
  from `http://localhost:11434`. The key is only ever sent to `https://ollama.com`.
- A local server is asked for at most 32,768 tokens of context unless `NULLRIVET_OLLAMA_NUM_CTX` is
  set, to protect the memory of the machine; the reported window is reduced to match.
- Some Ollama versions truncate a prompt that exceeds the window instead of rejecting it, so the
  compaction trigger is the main protection there.

## OpenRouter

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | API key. Required. |
| `NULLRIVET_OPENROUTER_BASE_URL` | Endpoint (default `https://openrouter.ai/api/v1`). Must be http or https. |
| `NULLRIVET_OPENROUTER_TITLE` | App title sent in `X-Title` (default `nullrivet`). |
| `NULLRIVET_OPENROUTER_REFERER` | Sent in `HTTP-Referer` only when set. |
| `NULLRIVET_OPENROUTER_REASONING_REPLAY` | Send the model's reasoning back on tool follow-ups (default on, for reasoning models). |

Request behavior:

- **No automatic truncation.** OpenRouter's middle-out compression is disabled, so the prompt is
  never cut silently; nullrivet sizes requests against the window instead.
- **No account data leaks.** The OpenAI SDK used for the transport would otherwise read
  `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` from the environment and send them to OpenRouter; both
  are disabled. Only the API key and the attribution headers above are sent.
- **Retries** are done by nullrivet, not by the SDK, so attempts are never multiplied. See
  [ARCHITECTURE.md](ARCHITECTURE.md#provider-step-and-retries).
- **Abort** cancels the HTTP request itself.

### Free models

OpenRouter's `:free` routes are selected and used like any other model. Differences to keep in
mind:

- OpenRouter can withdraw a free route at any time; a route that existed yesterday may answer 404
  today, which is why the catalog keeps only free models verified to work with tools;
- free routes have stricter rate limits (nullrivet retries 429 responses, honoring `Retry-After`);
- some free endpoints may record prompts on the provider side; each model's page on OpenRouter
  states its data policy.

To list the free models that currently support tools:

```bash
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[] | select((.id | endswith(":free")) and (.supported_parameters | index("tools"))) | .id'
```

## Usage and cost

Each model request reports its token usage in a `usage` event: input, output, cache read and cache
write tokens, as the provider reports them. nullrivet does not compute cost.
