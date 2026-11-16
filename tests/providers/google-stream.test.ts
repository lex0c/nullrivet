import { describe, expect, test } from 'bun:test';
import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL } from '../../src/providers/errors.ts';
import {
  normalizeGoogleStream,
  type RawGoogleChunk,
  SYNTHETIC_CALL_ID_PREFIX,
} from '../../src/providers/google/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';
import { collect, collectNonUsage } from './stream-helpers.ts';

const from = (chunks: RawGoogleChunk[]): AsyncIterable<RawGoogleChunk> =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

const toolIds = (events: StreamEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'tool_use_start' ? [e.id] : []));

describe('normalizeGoogleStream', () => {
  test('text parts become text deltas and STOP ends the turn', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          {
            responseId: 'r1',
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }],
          },
          {
            responseId: 'r1',
            candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
          },
        ]),
      ),
    );
    expect(ev).toEqual([
      { kind: 'start', message_id: 'r1' },
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('a function call becomes a complete tool call and the step stops for tool use', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          {
            responseId: 'r1',
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'glob', args: { pattern: 'src/*.ts' } } }],
                },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
      ),
    );
    const [id] = toolIds(ev);
    expect(id?.startsWith(SYNTHETIC_CALL_ID_PREFIX)).toBe(true);
    expect(ev.slice(1)).toEqual([
      { kind: 'tool_use_start', id: id as string, name: 'glob' },
      { kind: 'tool_use_delta', id: id as string, partial_args: '{"pattern":"src/*.ts"}' },
      { kind: 'tool_use_stop', id: id as string, final_args: { pattern: 'src/*.ts' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('an id issued by the API is kept', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          { candidates: [{ content: { parts: [{ functionCall: { id: 'fc-1', name: 't' } }] } }] },
        ]),
      ),
    );
    expect(toolIds(ev)).toEqual(['fc-1']);
    expect(ev).toContainEqual({ kind: 'tool_use_stop', id: 'fc-1', final_args: {} });
  });

  test('a signature is emitted verbatim as reasoning just before the part it belongs to', async () => {
    const signature = 'CiQB0e2Kb/+abc==';
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Listing files.' },
                    { functionCall: { name: 'glob', args: {} }, thoughtSignature: signature },
                    { functionCall: { name: 'read_file', args: { path: 'a' } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
      ),
    );
    expect(ev.map((e) => e.kind)).toEqual([
      'start',
      'text_delta',
      'reasoning',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_stop',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_stop',
      'stop',
    ]);
    expect(ev[2]).toEqual({
      kind: 'reasoning',
      provider: 'google',
      data: { thoughtSignature: signature },
    });
  });

  test('a signature on a final empty text part is still emitted', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          { candidates: [{ content: { parts: [{ text: 'done' }] } }] },
          {
            candidates: [
              { content: { parts: [{ text: '', thoughtSignature: 'sig' }] }, finishReason: 'STOP' },
            ],
          },
        ]),
      ),
    );
    expect(ev.slice(1)).toEqual([
      { kind: 'text_delta', text: 'done' },
      { kind: 'reasoning', provider: 'google', data: { thoughtSignature: 'sig' } },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('thought parts are shown as thinking', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([{ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }]),
      ),
    );
    expect(ev[1]).toEqual({ kind: 'thinking_delta', text: 'hmm' });
  });

  test('a function call without a name or with non-object arguments is an invalid tool call', async () => {
    for (const functionCall of [
      { args: { a: 1 } },
      { name: 't', args: [1, 2] },
      { name: 't', args: 'text' },
    ]) {
      const ev = await collectNonUsage(
        normalizeGoogleStream(from([{ candidates: [{ content: { parts: [{ functionCall }] } }] }])),
      );
      expect(ev.find((e) => e.kind === 'error')).toMatchObject({
        code: INVALID_TOOL_CALL,
        retryable: false,
      });
      expect(ev.some((e) => e.kind === 'tool_use_start')).toBe(false);
    }
  });

  test('a malformed function call reported as the finish reason is an invalid tool call', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          {
            candidates: [
              { finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call' },
            ],
          },
        ]),
      ),
    );
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({
      code: INVALID_TOOL_CALL,
      retryable: false,
    });
    expect((ev.find((e) => e.kind === 'error') as { message: string }).message).toContain(
      'Malformed function call',
    );
  });

  test('finish reasons map to stop reasons', async () => {
    for (const [finish, reason] of [
      ['MAX_TOKENS', 'max_tokens'],
      ['SAFETY', 'refusal'],
      ['PROHIBITED_CONTENT', 'refusal'],
      ['IMAGE_SAFETY', 'refusal'],
    ] as const) {
      const ev = await collectNonUsage(
        normalizeGoogleStream(from([{ candidates: [{ finishReason: finish }] }])),
      );
      expect(ev.at(-1)).toEqual({ kind: 'stop', reason });
    }
  });

  test('a finish reason the adapter does not know is an error, not a clean finish', async () => {
    for (const finish of [
      'OTHER',
      'FINISH_REASON_UNSPECIFIED',
      'TOO_MANY_TOOL_CALLS',
      'NEW_REASON',
    ]) {
      const ev = await collectNonUsage(
        normalizeGoogleStream(from([{ candidates: [{ finishReason: finish }] }])),
      );
      expect(ev.some((e) => e.kind === 'stop')).toBe(false);
      expect(ev.at(-1)).toMatchObject({
        kind: 'error',
        code: 'google.finish_reason',
        retryable: false,
      });
    }
  });

  test('a stop at the output limit is not turned into tool use', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(
        from([
          {
            candidates: [
              {
                content: { parts: [{ functionCall: { name: 't', args: {} } }] },
                finishReason: 'MAX_TOKENS',
              },
            ],
          },
        ]),
      ),
    );
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'max_tokens' });
  });

  test('a blocked prompt is a refusal', async () => {
    const ev = await collectNonUsage(
      normalizeGoogleStream(from([{ promptFeedback: { blockReason: 'SAFETY' } }])),
    );
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'refusal' });
  });

  test('usage counts thinking as output and takes cached tokens out of input', async () => {
    const ev = await collect(
      normalizeGoogleStream(
        from([
          {
            candidates: [{ content: { parts: [{ text: 'a' }] } }],
            usageMetadata: { promptTokenCount: 100 },
          },
          {
            candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 7,
              thoughtsTokenCount: 30,
              cachedContentTokenCount: 40,
            },
          },
        ]),
      ),
    );
    expect(ev.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', usage: { input: 60, output: 37, cache_read: 40, cache_creation: 0 } },
    ]);
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('an error event in the stream ends it without a stop', async () => {
    const ev = await collect(
      normalizeGoogleStream(
        from([
          { candidates: [{ content: { parts: [{ text: 'a' }] } }] },
          { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } },
        ]),
      ),
    );
    expect(ev.at(-1)).toEqual({
      kind: 'error',
      code: 'google.stream_error',
      message: 'The model is overloaded.',
      retryable: true,
    });
  });

  test('a permanent stream error is not retryable', async () => {
    const ev = await collect(
      normalizeGoogleStream(
        from([{ error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } }]),
      ),
    );
    expect(ev.at(-1)).toMatchObject({ kind: 'error', retryable: false });
  });

  test('an overflow reported in the stream becomes a context_overflow event', async () => {
    const ev = await collect(
      normalizeGoogleStream(
        from([
          {
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message:
                'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
            },
          },
        ]),
      ),
    );
    expect(ev.at(-1)).toMatchObject({ code: CONTEXT_OVERFLOW, retryable: false });
  });

  test('an empty stream starts but reports no stop, so it is not taken as complete', async () => {
    const ev = await collect(normalizeGoogleStream(from([])));
    expect(ev.map((e) => e.kind)).toEqual(['start']);
  });

  test('usage seen before a mid-stream failure is reported before the error propagates', async () => {
    const failing = (async function* (): AsyncIterable<RawGoogleChunk> {
      yield { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
      throw new Error('socket closed');
    })();
    const ev: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of normalizeGoogleStream(failing)) ev.push(e);
      })(),
    ).rejects.toThrow('socket closed');
    expect(ev).toContainEqual({
      kind: 'usage',
      usage: { input: 10, output: 2, cache_read: 0, cache_creation: 0 },
    });
  });
});
