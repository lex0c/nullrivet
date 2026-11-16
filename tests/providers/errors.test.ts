import { describe, expect, test } from 'bun:test';
import { isContextOverflowMessage } from '../../src/providers/errors.ts';

describe('isContextOverflowMessage', () => {
  test('recognizes the overflow wording of each provider', () => {
    for (const message of [
      'prompt is too long: 215000 tokens > 200000 maximum',
      'input length and `max_tokens` exceed context limit: 197202 + 21333 > 200000',
      'context_length_exceeded',
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      'Your input exceeds the context window of this model. Please adjust your input and try again.',
      'the input length exceeds the context length',
      'prompt too long; exceeded max context length by 42 tokens',
      "This endpoint's maximum context length is 131072 tokens.",
      "This model's maximum prompt length is 131072 but the request contains 140000 tokens.",
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      'The input token count exceeds the maximum number of tokens allowed 1048576.',
      "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (300188 tokens > 256000 tokens)",
    ]) {
      expect(isContextOverflowMessage(message)).toBe(true);
    }
  });

  test('does not match unrelated errors', () => {
    for (const message of [
      'max_tokens: must be at most 64000',
      'temperature: range is 0 to 1',
      'Rate limit exceeded',
      'Overloaded',
      'tools is not supported for this model',
      'invalid context management configuration',
    ]) {
      expect(isContextOverflowMessage(message)).toBe(false);
    }
  });
});
