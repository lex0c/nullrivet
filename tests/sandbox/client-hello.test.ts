import { describe, expect, test } from 'bun:test';
import { readClientHello } from '../../src/sandbox/network/client-hello.ts';
import { captureClientHello } from '../helpers/client-hello.ts';

const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const extension = (type: number, data: number[]): number[] => [
  ...u16(type),
  ...u16(data.length),
  ...data,
];
const serverName = (...names: string[]): number[] => {
  const list = names.flatMap((name) => [0, ...u16(name.length), ...Buffer.from(name)]);
  return extension(0, [...u16(list.length), ...list]);
};

// A ClientHello in one record, with the extensions given.
const hello = (extensions: number[], options: { record?: number[] } = {}): Uint8Array => {
  const body = [
    ...u16(0x0303),
    ...new Array(32).fill(7),
    0,
    ...u16(2),
    0x13,
    0x01,
    1,
    0,
    ...u16(extensions.length),
    ...extensions,
  ];
  const message = [1, 0, ...u16(body.length), ...body];
  const record = options.record ?? message;
  return new Uint8Array([22, 3, 1, ...u16(record.length), ...record]);
};

describe('the ClientHello of a tunnel', () => {
  test("reads the server name of a real client's ClientHello, and its record's length", async () => {
    const bytes = await captureClientHello('app.example.test');
    expect(readClientHello(bytes)).toEqual({
      kind: 'hello',
      serverName: 'app.example.test',
      length: bytes.length,
    });
    // Each prefix is incomplete, never refused: the proxy waits for the rest.
    for (const cut of [0, 1, 4, 5, 6, bytes.length - 1]) {
      expect(readClientHello(bytes.subarray(0, cut))).toEqual({ kind: 'incomplete' });
    }
    // What follows the record is the tunnel's, not the ClientHello's.
    const more = new Uint8Array([...bytes, 23, 3, 3, 0, 1, 0]);
    expect(readClientHello(more)).toEqual({
      kind: 'hello',
      serverName: 'app.example.test',
      length: bytes.length,
    });
  });

  test('reads a name with one host name, whatever the other extensions', () => {
    expect(
      readClientHello(hello([...extension(10, [0, 2, 0, 29]), ...serverName('A.test')])),
    ).toEqual(expect.objectContaining({ kind: 'hello', serverName: 'A.test' }));
  });

  test('refuses what does not name exactly one server in the clear', () => {
    const reasons = (bytes: Uint8Array) => {
      const read = readClientHello(bytes);
      return read.kind === 'refused' ? read.reason : read.kind;
    };
    expect(reasons(new TextEncoder().encode('GET / HTTP/1.1\r\n'))).toBe(
      'the tunnel does not start with a TLS handshake',
    );
    expect(reasons(hello([]))).toBe('the ClientHello names no server');
    expect(reasons(hello(extension(10, [0, 2, 0, 29])))).toBe('the ClientHello names no server');
    expect(reasons(hello(serverName('a.test', 'b.test')))).toBe(
      'the ClientHello names more than one server',
    );
    // Encrypted Client Hello, one of its drafts, and the encrypted server name it replaced.
    for (const code of [0xfe0d, 0xfe0a, 0xffce]) {
      expect(reasons(hello([...serverName('a.test'), ...extension(code, [0])]))).toBe(
        'the ClientHello encrypts the name of the server',
      );
    }
    expect(reasons(hello([...serverName('a.test'), ...serverName('b.test')]))).toBe(
      'the ClientHello repeats an extension',
    );
    expect(reasons(hello(extension(0, [...u16(4), 1, ...u16(1), 0x61])))).toBe(
      'the server name is not a host name',
    );
    expect(reasons(hello(serverName('a b')))).toBe('the server name is not a host name');
    expect(reasons(hello(extension(0, [...u16(9), 0, ...u16(1), 0x61])))).toBe(
      'the server name extension is malformed',
    );
  });

  test('refuses a ClientHello split across records, or with more than itself in its record', () => {
    const whole = hello(serverName('a.test'));
    const message = [...whole.subarray(5)];
    const split = hello([], { record: message.slice(0, 20) });
    expect(readClientHello(split)).toEqual({
      kind: 'refused',
      reason: 'the ClientHello does not fit in the first record',
    });
    const extra = hello([], { record: [...message, 20, 0, 0, 0] });
    expect(readClientHello(extra)).toEqual({
      kind: 'refused',
      reason: 'the first record holds more than the ClientHello',
    });
  });

  test('refuses lengths past what holds them, and records of no or too great a length', () => {
    const bytes = hello(serverName('a.test'));
    const record = [...bytes.subarray(5)];
    // The extensions claim one byte more than there is.
    const at = record.length - serverName('a.test').length - 2;
    const longer = [...record];
    longer[at + 1] = (longer[at + 1] as number) + 1;
    expect(readClientHello(hello([], { record: longer }))).toEqual({
      kind: 'refused',
      reason: 'the ClientHello is malformed',
    });
    expect(readClientHello(new Uint8Array([22, 3, 1, 0, 0]))).toEqual({
      kind: 'refused',
      reason: 'the first TLS record has an invalid length',
    });
    expect(readClientHello(new Uint8Array([22, 3, 1, 0x40, 1]))).toEqual({
      kind: 'refused',
      reason: 'the first TLS record has an invalid length',
    });
    expect(readClientHello(new Uint8Array([22, 3, 1, 0, 4, 2, 0, 0, 0]))).toEqual({
      kind: 'refused',
      reason: 'the first TLS message is not a ClientHello',
    });
  });
});
