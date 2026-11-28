// The server name a tunnel's first TLS record asks for, which the proxy holds to the name the
// tunnel was opened for before a byte of it reaches the target. Only the first record is read: a
// ClientHello split across records, or followed by other messages in its record, is refused
// rather than reassembled, since clients send it whole. What the tunnel carries after it is not
// inspected.

export type ClientHello =
  | { kind: 'incomplete' }
  | { kind: 'refused'; reason: string }
  // The server name as sent, and the length of the record that held it.
  | { kind: 'hello'; serverName: string; length: number };

const HANDSHAKE = 22;
const CLIENT_HELLO = 1;
const MAX_RECORD_BODY = 16_384;
export const MAX_CLIENT_HELLO_BYTES = 5 + MAX_RECORD_BODY;
const SERVER_NAME = 0x0000;
const HOST_NAME = 0;
// With them, the name that matters is encrypted, and the one in the clear names only a front: the
// code of Encrypted Client Hello, those of its drafts before, and that of the encrypted server
// name extension it replaced.
const ENCRYPTS_THE_NAME = (type: number): boolean =>
  (type >= 0xfe00 && type <= 0xfe0d) || type === 0xffce;

const refused = (reason: string): ClientHello => ({ kind: 'refused', reason });

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get left(): number {
    return this.bytes.length - this.at;
  }

  u8(): number | null {
    if (this.left < 1) return null;
    return this.bytes[this.at++] as number;
  }

  u16(): number | null {
    if (this.left < 2) return null;
    const value = ((this.bytes[this.at] as number) << 8) | (this.bytes[this.at + 1] as number);
    this.at += 2;
    return value;
  }

  take(length: number): Uint8Array | null {
    if (length > this.left) return null;
    const part = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return part;
  }
}

// The one host name of a server_name extension, or why there is none.
const hostNameOf = (data: Uint8Array): string | { reason: string } => {
  const reader = new Reader(data);
  const listLength = reader.u16();
  if (listLength === null || listLength !== reader.left) {
    return { reason: 'the server name extension is malformed' };
  }
  const type = reader.u8();
  const length = reader.u16();
  const name = length === null ? null : reader.take(length);
  if (type === null || name === null) return { reason: 'the server name extension is malformed' };
  if (type !== HOST_NAME) return { reason: 'the server name is not a host name' };
  if (reader.left !== 0) return { reason: 'the ClientHello names more than one server' };
  if (name.length === 0 || !name.every((byte) => byte > 0x20 && byte < 0x7f)) {
    return { reason: 'the server name is not a host name' };
  }
  return String.fromCharCode(...name);
};

export const readClientHello = (bytes: Uint8Array): ClientHello => {
  if (bytes.length < 5) return { kind: 'incomplete' };
  if (bytes[0] !== HANDSHAKE || bytes[1] !== 3 || (bytes[2] as number) > 3) {
    return refused('the tunnel does not start with a TLS handshake');
  }
  const recordLength = ((bytes[3] as number) << 8) | (bytes[4] as number);
  if (recordLength === 0 || recordLength > MAX_RECORD_BODY) {
    return refused('the first TLS record has an invalid length');
  }
  if (bytes.length < 5 + recordLength) return { kind: 'incomplete' };
  const record = new Reader(bytes.subarray(5, 5 + recordLength));
  if (record.u8() !== CLIENT_HELLO) return refused('the first TLS message is not a ClientHello');
  const high = record.u8();
  const low = record.u16();
  if (high === null || low === null) return refused('the ClientHello is malformed');
  const helloLength = (high << 16) | low;
  if (helloLength > record.left) {
    return refused('the ClientHello does not fit in the first record');
  }
  if (helloLength < record.left) return refused('the first record holds more than the ClientHello');
  const hello = record;
  // The version and the random value, then the session id, the cipher suites and the compression
  // methods, each with its length.
  if (hello.take(34) === null) return refused('the ClientHello is malformed');
  const sessionLength = hello.u8();
  if (sessionLength === null || sessionLength > 32 || hello.take(sessionLength) === null) {
    return refused('the ClientHello is malformed');
  }
  const suitesLength = hello.u16();
  if (
    suitesLength === null ||
    suitesLength === 0 ||
    suitesLength % 2 !== 0 ||
    hello.take(suitesLength) === null
  ) {
    return refused('the ClientHello is malformed');
  }
  const methodsLength = hello.u8();
  if (methodsLength === null || methodsLength === 0 || hello.take(methodsLength) === null) {
    return refused('the ClientHello is malformed');
  }
  if (hello.left === 0) return refused('the ClientHello names no server');
  const extensionsLength = hello.u16();
  if (extensionsLength === null || extensionsLength !== hello.left) {
    return refused('the ClientHello is malformed');
  }
  const seen = new Set<number>();
  let serverName: string | null = null;
  while (hello.left > 0) {
    const type = hello.u16();
    const length = hello.u16();
    const data = length === null ? null : hello.take(length);
    if (type === null || data === null) return refused('the ClientHello is malformed');
    if (seen.has(type)) return refused('the ClientHello repeats an extension');
    seen.add(type);
    if (ENCRYPTS_THE_NAME(type)) {
      return refused('the ClientHello encrypts the name of the server');
    }
    if (type === SERVER_NAME) {
      const name = hostNameOf(data);
      if (typeof name !== 'string') return refused(name.reason);
      serverName = name;
    }
  }
  if (serverName === null) return refused('the ClientHello names no server');
  return { kind: 'hello', serverName, length: 5 + recordLength };
};
