import { describe, expect, test } from 'bun:test';
import {
  certificateErrorCode,
  certificateRejection,
  isContextOverflowMessage,
  isStaleReasoningMessage,
} from '../../src/providers/errors.ts';

describe('certificateErrorCode', () => {
  test('recognizes the codes of rejected certificates', () => {
    for (const code of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      expect(certificateErrorCode(Object.assign(new TypeError('x'), { code }))).toBe(code);
    }
  });

  test('ignores other failures', () => {
    for (const error of [
      Object.assign(new TypeError('x'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
      new TypeError('fetch failed'),
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      null,
    ]) {
      expect(certificateErrorCode(error)).toBeUndefined();
    }
  });

  test('names NODE_EXTRA_CA_CERTS only when the issuer is not trusted', () => {
    expect(certificateRejection('DEPTH_ZERO_SELF_SIGNED_CERT')).toContain('NODE_EXTRA_CA_CERTS');
    expect(certificateRejection('CERT_HAS_EXPIRED')).not.toContain('NODE_EXTRA_CA_CERTS');
  });
});

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

describe('isStaleReasoningMessage', () => {
  test('recognizes a thinking block the API no longer accepts', () => {
    for (const message of [
      'messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
      'messages.3.content.0: Invalid `signature` in `thinking` block',
      'messages.1.content.0: Invalid signature in redacted_thinking block',
    ]) {
      expect(isStaleReasoningMessage(message)).toBe(true);
    }
  });

  test('does not match other errors about thinking', () => {
    for (const message of [
      'thinking: budget_tokens must be at least 1024',
      'thinking.type: Input should be adaptive',
      'prompt is too long: 215000 tokens > 200000 maximum',
    ]) {
      expect(isStaleReasoningMessage(message)).toBe(false);
    }
  });
});
