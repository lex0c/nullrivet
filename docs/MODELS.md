# Models and providers

## Model ids

A model is selected as `<family>/<model>` with `--model` or `NULLRIVET_MODEL`. The family is the
text before the first `/`; the rest is the model name sent to the provider. OpenRouter names have
a vendor prefix of their own:

```
openrouter/deepseek/deepseek-v4-flash
openrouter/cohere/north-mini-code:free
```

| Family | Status |
|---|---|
| `openrouter` | Supported. |
| `anthropic`, `openai`, `ollama`, `google`, `xai` | Planned; selecting them reports that the family is not supported yet. |

## Resolution

nullrivet has no catalog file and never writes one. The capabilities of a model (context window,
output limit, reasoning and sampling support) are resolved in this order:

1. **Compiled catalog.** Curated entries built into nullrivet. When the id is in the catalog, the
   entry is used as is and nothing else is consulted.
2. **Discovery.** For ids missing from the catalog, nullrivet reads the provider's public model
   listing (`GET /models` on OpenRouter, no API key needed), with a 5 s timeout. The result is kept
   in memory for the rest of the process.
3. **Defaults.** When discovery is unavailable or fails, the model is accepted with a warning and
   conservative values: a 32,768-token window, 8,192 output tokens, no reasoning, and no sampling
   parameters.

A model the listing shows without tool calling is rejected, since the agent depends on it. An id
missing from a valid listing is an error rather than a fallback to defaults, so typos fail early.

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

### Discovery mapping (OpenRouter)

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
always fit in the window. See [ARCHITECTURE.md](ARCHITECTURE.md#context-limits).

## Reasoning effort

`--effort` (`low`, `medium`, `high`, `xhigh`, `max`) is translated per model:

- models with `supports_reasoning_effort` receive the level, with `max` mapped to `xhigh`;
- models with only `supports_reasoning` have reasoning switched on;
- other models ignore it.

Without `--effort`, no reasoning parameter is sent and the provider's default applies.

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
