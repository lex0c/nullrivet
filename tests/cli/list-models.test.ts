import { describe, expect, test } from 'bun:test';
import { formatModelList } from '../../src/cli/list-models.ts';
import { MODEL_CATALOG, type ModelEntry } from '../../src/providers/catalog.ts';

describe('formatModelList', () => {
  test('aligns the columns, right-aligns the token counts and names the reasoning support', () => {
    const entries: ModelEntry[] = [
      {
        id: 'anthropic/a',
        family: 'anthropic',
        model: 'a',
        capabilities: {
          context_window: 200_000,
          output_max_tokens: 32_768,
          supports_reasoning_effort: true,
        },
      },
      {
        id: 'ollama/b:7b',
        family: 'ollama',
        model: 'b:7b',
        capabilities: {
          context_window: 32_768,
          output_max_tokens: 8_192,
          supports_reasoning: true,
        },
        baseUrl: 'https://ollama.com',
      },
      {
        id: 'openai/long-model-name',
        family: 'openai',
        model: 'long-model-name',
        capabilities: { context_window: 1_050_000, output_max_tokens: 16_384 },
      },
    ];
    expect(formatModelList(entries)).toBe(
      [
        'MODEL                   CONTEXT  OUTPUT  REASONING  ENDPOINT',
        'anthropic/a              200000   32768  levels',
        'ollama/b:7b               32768    8192  yes        https://ollama.com',
        'openai/long-model-name  1050000   16384  no',
        '',
      ].join('\n'),
    );
  });

  test('lists every catalog model once, in catalog order', () => {
    const lines = formatModelList(MODEL_CATALOG).trimEnd().split('\n');
    expect(lines[0]).toStartWith('MODEL ');
    expect(lines.slice(1).map((line) => line.split(' ')[0])).toEqual(
      MODEL_CATALOG.map((entry) => entry.id),
    );
  });
});
