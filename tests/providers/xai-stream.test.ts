import { describe, expect, test } from 'bun:test';
import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL } from '../../src/providers/errors.ts';
import { normalizeXaiStream, type RawXaiChunk } from '../../src/providers/xai/stream.ts';
import { collect, collectNonUsage } from './stream-helpers.ts';

const from = (chunks: RawXaiChunk[]): AsyncIterable<RawXaiChunk> =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

describe('normalizeXaiStream', () => {
  test('text deltas, then stop', async () => {
    const ev = await collectNonUsage(
      normalizeXaiStream(
        from([
          { id: 'x1', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
          { id: 'x1', choices: [{ delta: { content: 'lo' } }] },
          { id: 'x1', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(ev).toEqual([
      { kind: 'start', message_id: 'x1' },
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('reasoning_content is shown as thinking and never emitted as replayable reasoning', async () => {
    const ev = await collectNonUsage(
      normalizeXaiStream(
        from([
          { id: 'x1', choices: [{ delta: { reasoning_content: 'consider' } }] },
          { id: 'x1', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(ev).toEqual([
      { kind: 'start', message_id: 'x1' },
      { kind: 'thinking_delta', text: 'consider' },
      { kind: 'text_delta', text: 'answer' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('a complete tool call in one delta, as xAI sends it', async () => {
    const ev = await collectNonUsage(
      normalizeXaiStream(
        from([
          {
            id: 'x1',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'glob', arguments: '{"pattern":"src/*.ts"}' },
                    },
                  ],
                },
              },
            ],
          },
          { id: 'x1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(ev).toEqual([
      { kind: 'start', message_id: 'x1' },
      { kind: 'tool_use_start', id: 'call-1', name: 'glob' },
      { kind: 'tool_use_delta', id: 'call-1', partial_args: '{"pattern":"src/*.ts"}' },
      { kind: 'tool_use_stop', id: 'call-1', final_args: { pattern: 'src/*.ts' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('a tool call split across deltas is reassembled, including its name', async () => {
    const ev = await collectNonUsage(
      normalizeXaiStream(
        from([
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_' } }] } },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file' } }] } }] },
          {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(ev.slice(1)).toEqual([
      { kind: 'tool_use_start', id: 'c1', name: 'read_file' },
      { kind: 'tool_use_delta', id: 'c1', partial_args: '{"pa' },
      { kind: 'tool_use_delta', id: 'c1', partial_args: 'th":"a"}' },
      { kind: 'tool_use_stop', id: 'c1', final_args: { path: 'a' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('arguments that are not a JSON object become an invalid tool call', async () => {
    for (const args of ['{"a":', '[1,2]', 'null']) {
      const ev = await collectNonUsage(
        normalizeXaiStream(
          from([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: args } }],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]),
        ),
      );
      const error = ev.find((e) => e.kind === 'error');
      expect(error).toMatchObject({ code: INVALID_TOOL_CALL, retryable: false });
      expect(ev.some((e) => e.kind === 'tool_use_stop')).toBe(false);
    }
  });

  test('a tool call without a name is an invalid tool call', async () => {
    const ev = await collectNonUsage(
      normalizeXaiStream(
        from([
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{}' } }] } },
            ],
          },
        ]),
      ),
    );
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: INVALID_TOOL_CALL });
  });

  test('reasoning tokens are added to output and cached tokens taken out of input', async () => {
    const ev = await collect(
      normalizeXaiStream(
        from([
          { id: 'x1', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
          {
            id: 'x1',
            choices: [],
            usage: {
              prompt_tokens: 280,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 128 },
              completion_tokens_details: { reasoning_tokens: 170 },
            },
          },
        ]),
      ),
    );
    expect(ev.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      usage: { input: 152, output: 182, cache_read: 128, cache_creation: 0 },
    });
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('no usage event without a usage chunk', async () => {
    const ev = await collect(
      normalizeXaiStream(from([{ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }])),
    );
    expect(ev.some((e) => e.kind === 'usage')).toBe(false);
  });

  test('finish reasons map to stop reasons', async () => {
    for (const [finish, reason] of [
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
      ['unknown', 'end_turn'],
    ] as const) {
      const ev = await collectNonUsage(
        normalizeXaiStream(from([{ choices: [{ delta: {}, finish_reason: finish }] }])),
      );
      expect(ev.at(-1)).toEqual({ kind: 'stop', reason });
    }
  });

  test('a stream error ends the stream with an error event and no stop', async () => {
    const ev = await collect(
      normalizeXaiStream(
        from([
          { id: 'x1', choices: [{ delta: { content: 'a' } }] },
          { error: { message: 'boom' } },
        ]),
      ),
    );
    expect(ev.at(-1)).toEqual({
      kind: 'error',
      code: 'xai.stream_error',
      message: 'boom',
      retryable: false,
    });
  });

  test('a stream error with a transient code is retryable', async () => {
    const ev = await collect(normalizeXaiStream(from([{ error: { code: 503, message: 'busy' } }])));
    expect(ev.at(-1)).toMatchObject({ kind: 'error', retryable: true });
  });

  test('an overflow reported in the stream becomes a context_overflow event', async () => {
    const ev = await collect(
      normalizeXaiStream(
        from([
          {
            error: {
              message:
                "The prompt is too long for this model's context window (300188 tokens > 256000 tokens)",
            },
          },
        ]),
      ),
    );
    expect(ev.at(-1)).toMatchObject({ code: CONTEXT_OVERFLOW, retryable: false });
  });

  test('an empty stream still starts and stops', async () => {
    const ev = await collect(normalizeXaiStream(from([])));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'stop']);
  });

  test('usage seen before a mid-stream failure is reported before the error propagates', async () => {
    const failing = (async function* (): AsyncIterable<RawXaiChunk> {
      yield { id: 'x1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } };
      throw new Error('socket closed');
    })();
    const ev: unknown[] = [];
    await expect(
      (async () => {
        for await (const e of normalizeXaiStream(failing)) ev.push(e);
      })(),
    ).rejects.toThrow('socket closed');
    expect(ev).toContainEqual({
      kind: 'usage',
      usage: { input: 10, output: 2, cache_read: 0, cache_creation: 0 },
    });
  });
});
