import { normalizedHost } from '../engagement.ts';

// The head of a request to the proxy, read strictly: what the proxy validates must be what the
// target reads, so anything two parsers could read two ways is refused rather than interpreted.
// Lines end in CRLF; a field line folded onto the next, a field name that is not a token, a value
// with a control character, two Host or two Content-Length fields, and Transfer-Encoding are all
// refused.

export const MAX_HEAD_BYTES = 16 * 1024;
const MAX_FIELDS = 100;
// A body is streamed and counted, never held; the limit keeps its length an exact integer.
export const MAX_BODY_BYTES = 1024 ** 3;

export interface Field {
  name: string;
  value: string;
}

export interface RequestHead {
  method: string;
  target: string;
  version: string;
  fields: Field[];
  // The bytes of the head, up to and including the empty line.
  length: number;
}

export type Refusal = { status: number; reason: string };
export type HeadRead =
  | { kind: 'incomplete' }
  | ({ kind: 'refused' } & Refusal)
  | { kind: 'head'; head: RequestHead };

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TARGET = /^[\x21-\x7e]+$/;
const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const VERSION = /^HTTP\/1\.[01]$/;

const refused = (status: number, reason: string): HeadRead => ({ kind: 'refused', status, reason });

const endOfHead = (bytes: Uint8Array): number => {
  for (let at = 3; at < bytes.length; at += 1) {
    if (bytes[at - 3] === 13 && bytes[at - 2] === 10 && bytes[at - 1] === 13 && bytes[at] === 10) {
      return at + 1;
    }
  }
  return -1;
};

export const readRequestHead = (bytes: Uint8Array): HeadRead => {
  const end = endOfHead(bytes.subarray(0, MAX_HEAD_BYTES));
  if (end === -1) {
    return bytes.length >= MAX_HEAD_BYTES
      ? refused(431, `the request head is longer than ${MAX_HEAD_BYTES} bytes`)
      : { kind: 'incomplete' };
  }
  const text = Buffer.from(bytes.subarray(0, end - 4)).toString('latin1');
  const lines = text.split('\r\n');
  if (lines.some((line) => line.includes('\r') || line.includes('\n'))) {
    return refused(400, 'a line of the request head does not end in CRLF');
  }
  const [method, target, version, ...rest] = (lines[0] ?? '').split(' ');
  if (
    rest.length > 0 ||
    method === undefined ||
    target === undefined ||
    version === undefined ||
    !TOKEN.test(method) ||
    !TARGET.test(target) ||
    !VERSION.test(version)
  ) {
    return refused(400, 'the request line is not one of HTTP/1.1');
  }
  const fields: Field[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      return refused(400, 'a field line is folded onto the next');
    }
    const colon = line.indexOf(':');
    const name = colon === -1 ? '' : line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
    if (!TOKEN.test(name) || !VALUE.test(value)) {
      return refused(400, 'a field line is not a name and a value');
    }
    fields.push({ name, value });
  }
  if (fields.length > MAX_FIELDS)
    return refused(431, `the request has more than ${MAX_FIELDS} fields`);
  return { kind: 'head', head: { method, target, version, fields, length: end } };
};

export const fieldValues = (head: RequestHead, name: string): string[] =>
  head.fields.filter((field) => field.name.toLowerCase() === name).map((field) => field.value);

export interface Authority {
  host: string;
  port: number;
}

// A host name and a port, given by name only: an address in a request would reach the target
// without its name being checked.
const authority = (
  host: string,
  port: string | undefined,
  fallback: number,
): Authority | string => {
  const normal = normalizedHost(host);
  if ('problem' in normal) {
    return normal.problem === 'address'
      ? 'the proxy reaches hosts by name, not by address'
      : 'the request does not name a host';
  }
  const number = port === undefined ? fallback : Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) {
    return 'the request names an invalid port';
  }
  return { host: normal.name, port: number };
};

// The host and port of a CONNECT, in authority form.
export const connectTarget = (target: string): Authority | string => {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (match === null) return 'a CONNECT names a host and a port, as app.example:443';
  return authority(match[1] as string, match[2], 0);
};

export interface PlainRequest {
  authority: Authority;
  // The head the target receives, rebuilt from what was validated.
  head: Buffer;
  // The bytes of body that follow the head, exactly.
  bodyLength: number;
}

// Fields that concern only the connection to the proxy, or that the rebuilt head sets itself.
const DROPPED = new Set([
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'host',
  'content-length',
]);

// A request in absolute form for plain HTTP, made into the one request the target receives on its
// connection: in origin form, with the Host and Content-Length the proxy validated and
// Connection: close. A Connection field naming any other field is refused, since dropping a field
// it names could change how the target frames or routes what the proxy checked.
export const plainRequest = (head: RequestHead): PlainRequest | Refusal => {
  const target = /^[Hh][Tt][Tt][Pp]:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[\x21-\x7e]*)?$/.exec(
    head.target,
  );
  if (target === null) {
    return /^https:/i.test(head.target)
      ? { status: 400, reason: 'an https URL goes through the proxy with CONNECT' }
      : { status: 400, reason: 'a request to the proxy names an http URL in full' };
  }
  const named = authority(target[1] as string, target[2], 80);
  if (typeof named === 'string') return { status: 400, reason: named };
  const hosts = fieldValues(head, 'host');
  const host =
    hosts.length === 1 ? /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(hosts[0] as string) : null;
  const stated = host === null ? null : authority(host[1] as string, host[2], 80);
  if (
    stated === null ||
    typeof stated === 'string' ||
    stated.host !== named.host ||
    stated.port !== named.port
  ) {
    return { status: 400, reason: 'the Host field must be the host and port of the URL, once' };
  }
  const connection = fieldValues(head, 'connection')
    .flatMap((value) => value.split(','))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
  if (connection.some((token) => token !== 'close' && token !== 'keep-alive')) {
    return { status: 400, reason: 'the Connection field may only say close or keep-alive' };
  }
  if (fieldValues(head, 'transfer-encoding').length > 0) {
    return { status: 501, reason: 'a body goes with Content-Length, not Transfer-Encoding' };
  }
  if (fieldValues(head, 'upgrade').length > 0) {
    return { status: 501, reason: 'the proxy does not upgrade a connection' };
  }
  const expect = fieldValues(head, 'expect');
  if (expect.length > 1 || (expect.length === 1 && expect[0]?.toLowerCase() !== '100-continue')) {
    return { status: 417, reason: 'the only expectation the proxy passes on is 100-continue' };
  }
  const lengths = fieldValues(head, 'content-length');
  if (lengths.length > 1 || (lengths.length === 1 && !/^\d{1,10}$/.test(lengths[0] as string))) {
    return { status: 400, reason: 'the Content-Length field must be one number, once' };
  }
  const bodyLength = lengths.length === 0 ? 0 : Number(lengths[0]);
  if (bodyLength > MAX_BODY_BYTES) {
    return { status: 413, reason: `a body may hold ${MAX_BODY_BYTES} bytes at most` };
  }
  const shown = named.port === 80 ? named.host : `${named.host}:${named.port}`;
  const lines = [
    `${head.method} ${target[3] ?? '/'} ${head.version}`,
    ...head.fields
      .filter((field) => !DROPPED.has(field.name.toLowerCase()))
      .map((field) => `${field.name}: ${field.value}`),
    `Host: ${shown}`,
    ...(lengths.length === 0 ? [] : [`Content-Length: ${bodyLength}`]),
    'Connection: close',
  ];
  return {
    authority: named,
    head: Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
    bodyLength,
  };
};
