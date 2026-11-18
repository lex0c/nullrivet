import { FAMILY_ADAPTERS, type ModelEntry } from '../providers/catalog.ts';
import { displayUrl } from '../providers/discovery.ts';
import type { Env } from '../providers/env.ts';
import { modelBaseUrl } from '../providers/resolve.ts';
import type { ProviderCapabilities } from '../providers/types.ts';

const HEADER = ['MODEL', 'CONTEXT', 'OUTPUT', 'REASONING', 'ENDPOINT'] as const;
// The token counts are right-aligned so their magnitudes line up.
const RIGHT_ALIGNED: ReadonlySet<number> = new Set([1, 2]);

// Whether the model reasons, and with selectable effort levels. What --effort does to a model that
// reasons without levels differs by provider, so the column does not say.
const reasoning = (capabilities: ProviderCapabilities): string => {
  if (capabilities.supports_reasoning_effort === true) return 'levels';
  if (capabilities.supports_reasoning === true) return 'yes';
  return 'no';
};

// Where the model's requests go with this environment. A base URL from the environment can hold
// credentials or a query string, so only its origin and path are shown.
const endpoint = (entry: ModelEntry, env: Env): string => {
  const adapter = FAMILY_ADAPTERS[entry.family];
  const url = modelBaseUrl(adapter, entry, env);
  return url === undefined ? `invalid ${adapter.baseUrlEnv}` : displayUrl(url).replace(/\/$/, '');
};

// The catalog as a table, one model per row in catalog order.
export const formatModelList = (entries: readonly ModelEntry[], env: Env): string => {
  const rows: string[][] = [
    [...HEADER],
    ...entries.map((entry) => [
      entry.id,
      String(entry.capabilities.context_window),
      String(entry.capabilities.output_max_tokens),
      reasoning(entry.capabilities),
      endpoint(entry, env),
    ]),
  ];
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  const lines = rows.map((row) =>
    row
      .map((cell, column) => {
        const width = widths[column] ?? 0;
        return RIGHT_ALIGNED.has(column) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd(),
  );
  return `${lines.join('\n')}\n`;
};
