import { describe, expect, test } from 'bun:test';
import { INVALID_TOOL_CALL } from '../../src/providers/errors.ts';
import { normalizeOpenAIStream, type RawOpenAIChunk } from '../../src/providers/openai/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';
import { collect, collectNonUsage } from './stream-helpers.ts';

const fromChunks = (chunks: RawOpenAIChunk[]): AsyncIterable<RawOpenAIChunk> =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

describe('normalizeOpenAIStream', () => {
  test('text-only stream: id from first chunk, deltas, stop', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'chatcmpl-1', choices: [{ delta: { role: 'assistant', content: '' } }] },
          { id: 'chatcmpl-1', choices: [{ delta: { content: 'hello' } }] },
          { id: 'chatcmpl-1', choices: [{ delta: { content: ' world' } }] },
          { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'chatcmpl-1' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'text_delta', text: ' world' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('synthesizes message_id when first chunk has none', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
      ),
    );
    const start = events.find((e) => e.kind === 'start');
    expect(start).toBeDefined();
    if (start?.kind === 'start') {
      expect(start.message_id).toMatch(/^openai_/);
    }
  });

  test('tool_call: name in first chunk, args streamed across chunks, stop after stream end', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'c', choices: [{ delta: { role: 'assistant' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_abc',
                      type: 'function',
                      function: { name: 'read_file', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"/etc/hosts"}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'c' },
      { kind: 'tool_use_start', id: 'call_abc', name: 'read_file' },
      { kind: 'tool_use_delta', id: 'call_abc', partial_args: '{"path":' },
      { kind: 'tool_use_delta', id: 'call_abc', partial_args: '"/etc/hosts"}' },
      { kind: 'tool_use_stop', id: 'call_abc', final_args: { path: '/etc/hosts' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('multiple tool_calls tracked by index, finalized in index order', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 1,
                      id: 'b',
                      type: 'function',
                      function: { name: 'glob', arguments: '{"p":"*.ts"}' },
                    },
                    {
                      index: 0,
                      id: 'a',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"/x"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const stops = events.filter((e) => e.kind === 'tool_use_stop');
    // Sorted by tool_call index, regardless of arrival order.
    expect(stops).toEqual([
      { kind: 'tool_use_stop', id: 'a', final_args: { path: '/x' } },
      { kind: 'tool_use_stop', id: 'b', final_args: { p: '*.ts' } },
    ]);
  });

  test('synthesizes tool_call id when SDK omits it', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, type: 'function', function: { name: 'foo', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    expect(start).toBeDefined();
    if (start?.kind === 'tool_use_start') {
      expect(start.id).toMatch(/^call_/);
    }
  });

  test('id is locked at start: a later id is ignored to keep start/stop coherent', async () => {
    // The first chunk has no id, so one is synthesized; a later chunk carries a real id. The
    // agent pairs tool_use_stop with tool_use_start by id, so the id must not change after start.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, type: 'function', function: { name: 'foo' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: 'late_id', function: { arguments: '{}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    const stop = events.find((e) => e.kind === 'tool_use_stop');
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    if (start?.kind === 'tool_use_start' && stop?.kind === 'tool_use_stop') {
      // start and stop must share the id; its value (synthesized or real) does not matter.
      expect(stop.id).toBe(start.id);
      // The late real id must NOT have replaced the synthesized one.
      expect(stop.id).not.toBe('late_id');
    }
  });

  test('name straggling to a later chunk: start fires once name is known with the right name', async () => {
    // Chunk 1 carries the id but no function name (and some args); chunk 2 supplies the name.
    // Starting the call on chunk 1 would announce a tool with an empty name.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_x',
                      type: 'function',
                      function: { arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { name: 'read_file', arguments: '"/etc/hosts"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    const stop = events.find((e) => e.kind === 'tool_use_stop');
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    if (start?.kind === 'tool_use_start') {
      expect(start.name).toBe('read_file');
      expect(start.id).toBe('call_x');
    }
    if (stop?.kind === 'tool_use_stop') {
      expect(stop.id).toBe('call_x');
      expect(stop.final_args).toEqual({ path: '/etc/hosts' });
    }
    // The first delta arrived BEFORE start would have been an orphan.
    // With deferral, start fires first; the buffered bytes are flushed
    // as a single delta after.
    const startIdx = events.findIndex((e) => e.kind === 'tool_use_start');
    const firstDeltaIdx = events.findIndex((e) => e.kind === 'tool_use_delta');
    expect(firstDeltaIdx).toBeGreaterThan(startIdx);
  });

  test('a name split across deltas is accumulated to the full name before start', async () => {
    // `read_` then `file` must reconstruct to `read_file`, not truncate to the
    // first fragment (which would invoke an unknown `read_` tool).
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_x', type: 'function', function: { name: 'read_' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file' } }] } }] },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    expect(start?.kind === 'tool_use_start' && start.name).toBe('read_file');
    expect(events.find((e) => e.kind === 'tool_use_stop')).toEqual({
      kind: 'tool_use_stop',
      id: 'call_x',
      final_args: { path: 'a.ts' },
    });
  });

  test('tool_call that ends without a name emits an error (no orphan stop)', async () => {
    // A call whose name never arrives must not produce a tool_use_stop without a start; it
    // becomes an invalid tool call instead.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_orphan',
                      type: 'function',
                      function: { arguments: '{}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'tool_use_start')).toBeUndefined();
    expect(events.find((e) => e.kind === 'tool_use_stop')).toBeUndefined();
    const error = events.find((e) => e.kind === 'error');
    expect(error).toBeDefined();
    if (error?.kind === 'error') {
      expect(error.code).toBe(INVALID_TOOL_CALL);
      expect(error.message).toContain('call_orphan');
    }
  });

  test('start/delta/stop ids stay consistent across the lifecycle', async () => {
    // Three chunks: name-only, args-only, finish. Every event for index 0 must carry the same id.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_locked', type: 'function', function: { name: 'foo' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const ids = events
      .filter(
        (e) =>
          e.kind === 'tool_use_start' || e.kind === 'tool_use_delta' || e.kind === 'tool_use_stop',
      )
      .map((e) => ('id' in e ? e.id : ''));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('call_locked');
  });

  test('refusal field is emitted as text_delta', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'c', choices: [{ delta: { refusal: "I can't help with that." } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'text_delta', text: "I can't help with that." });
  });

  test('content and refusal in the same chunk both emit, in declared order', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            id: 'c',
            choices: [{ delta: { content: 'visible.', refusal: 'sorry, refused.' } }],
          },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    const textDeltas = events.filter((e) => e.kind === 'text_delta');
    expect(textDeltas).toEqual([
      { kind: 'text_delta', text: 'visible.' },
      { kind: 'text_delta', text: 'sorry, refused.' },
    ]);
  });

  test('a real-looking id in chunk 1 is not overwritten by a later chunk', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_real_xyz',
                      type: 'function',
                      function: { name: 'foo', arguments: '{' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_other_abc', function: { arguments: '}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    // The id from chunk 1 must survive even though another `call_`-prefixed id arrived later.
    const stop = events.find((e) => e.kind === 'tool_use_stop');
    expect(stop).toBeDefined();
    if (stop?.kind === 'tool_use_stop') {
      expect(stop.id).toBe('call_real_xyz');
    }
    const start = events.find((e) => e.kind === 'tool_use_start');
    if (start?.kind === 'tool_use_start') {
      expect(start.id).toBe('call_real_xyz');
    }
  });

  test('finish_reason mapping: stop / length / tool_calls / function_call / content_filter', async () => {
    const cases: Array<[string, StreamEvent]> = [
      ['stop', { kind: 'stop', reason: 'end_turn' }],
      ['length', { kind: 'stop', reason: 'max_tokens' }],
      ['tool_calls', { kind: 'stop', reason: 'tool_use' }],
      ['function_call', { kind: 'stop', reason: 'tool_use' }],
      ['content_filter', { kind: 'stop', reason: 'refusal' }],
      ['something_new', { kind: 'stop', reason: 'end_turn' }],
    ];
    for (const [reason, expected] of cases) {
      const events = await collectNonUsage(
        normalizeOpenAIStream(fromChunks([{ choices: [{ delta: {}, finish_reason: reason }] }])),
      );
      expect(events).toContainEqual(expected);
    }
  });

  test('null finish_reason in earlier chunk does not clobber a later valid one', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { choices: [{ delta: { content: 'a' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('malformed tool_call args emit an error event and drop the tool_use_stop', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 't',
                      type: 'function',
                      function: { name: 'foo', arguments: '{not json' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const error = events.find((e) => e.kind === 'error');
    expect(error).toBeDefined();
    if (error?.kind === 'error') {
      expect(error.code).toBe(INVALID_TOOL_CALL);
      expect(error.retryable).toBe(false);
    }
    expect(events.find((e) => e.kind === 'tool_use_stop')).toBeUndefined();
  });

  test('a stream that ends without a finish reason reports no stop, so it is not taken as complete', async () => {
    const empty = await collectNonUsage(normalizeOpenAIStream(fromChunks([])));
    expect(empty.map((e) => e.kind)).toEqual(['start']);
    const cut = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([{ id: 'c', choices: [{ delta: { content: 'half an an' } }] }]),
      ),
    );
    expect(cut.map((e) => e.kind)).toEqual(['start', 'text_delta']);
  });

  test('does NOT emit a usage event when chunk.usage is an empty object', async () => {
    // Compatible endpoints sometimes return `usage: {}` without token fields, which is not a
    // measurement and must not produce a usage event.
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: {} },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'usage')).toBeUndefined();
  });

  test('emits usage from finally when stream errors after a usage chunk arrived', async () => {
    // Some compatible endpoints send usage before the final chunk. When the connection drops
    // after it, the usage is still reported.
    const erroringRaw = (async function* (): AsyncIterable<RawOpenAIChunk> {
      yield { id: 'cmpl-x', choices: [{ delta: { content: 'partial' } }] };
      yield {
        choices: [],
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      };
      throw new Error('socket closed');
    })();
    const events: StreamEvent[] = [];
    try {
      for await (const ev of normalizeOpenAIStream(erroringRaw)) events.push(ev);
    } catch {}
    const usageEv = events.find((e) => e.kind === 'usage');
    expect(usageEv).toBeDefined();
    if (usageEv?.kind === 'usage') {
      expect(usageEv.usage.input).toBe(200);
      expect(usageEv.usage.output).toBe(30);
    }
  });

  test('does NOT double-emit usage on the happy path', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]),
      ),
    );
    const usageEvents = events.filter((e) => e.kind === 'usage');
    expect(usageEvents).toHaveLength(1);
  });

  test('partial later usage chunk does not zero earlier prompt/cache values', async () => {
    // A usage chunk carrying only completion_tokens must not reset the prompt and cache counts
    // reported earlier; the largest value seen is kept.
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 1200,
              prompt_tokens_details: { cached_tokens: 1000 },
              completion_tokens: 5,
            },
          },
          // Later chunk carries only completion_tokens — must NOT erase
          // prompt/cache values from the earlier chunk.
          { choices: [], usage: { completion_tokens: 12 } },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage).toEqual({ input: 200, output: 12, cache_read: 1000, cache_creation: 0 });
  });

  test('emits a usage event when only completion_tokens is present', async () => {
    // Partial measurement (one field set) is still measurement.
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { completion_tokens: 9 } },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage.output).toBe(9);
    expect(u.usage.input).toBe(0);
  });

  test('does NOT emit a usage event when no chunk carries usage (compat endpoint case)', async () => {
    // Some OpenAI-compatible endpoints drop stream_options. A synthetic zero would read as a
    // measured zero, so no usage event is emitted.
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'usage')).toBeUndefined();
  });

  test('extracts usage from final chunk and splits cached_tokens out of prompt total', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: 1000 },
            },
          },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    // `input` excludes the cached tokens, which are reported as cache_read.
    expect(u.usage).toEqual({ input: 200, output: 50, cache_read: 1000, cache_creation: 0 });
  });
});
