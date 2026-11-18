import type { ModelEntry } from '../providers/catalog.ts';
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

// The catalog as a table, one model per row in catalog order. The endpoint is shown only for a
// model served by another host than its family's default.
export const formatModelList = (entries: readonly ModelEntry[]): string => {
  const rows: string[][] = [
    [...HEADER],
    ...entries.map(({ id, capabilities, baseUrl }) => [
      id,
      String(capabilities.context_window),
      String(capabilities.output_max_tokens),
      reasoning(capabilities),
      baseUrl ?? '',
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
