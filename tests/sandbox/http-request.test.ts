import { describe, expect, test } from 'bun:test';
import {
  connectTarget,
  MAX_HEAD_BYTES,
  plainRequest,
  type RequestHead,
  readRequestHead,
} from '../../src/sandbox/network/http-request.ts';

const bytes = (text: string): Uint8Array => Buffer.from(text, 'latin1');

const head = (text: string): RequestHead => {
  const read = readRequestHead(bytes(text));
  if (read.kind !== 'head') throw new Error(`not a head: ${JSON.stringify(read)}`);
  return read.head;
};

const refusal = (text: string) => {
  const read = readRequestHead(bytes(text));
  return read.kind === 'refused' ? [read.status, read.reason] : read.kind;
};

const plain = (text: string) => {
  const request = plainRequest(head(text));
  return 'head' in request
    ? { ...request, head: request.head.toString('latin1') }
    : [request.status, request.reason];
};

describe('the head of a request to the proxy', () => {
  test('reads the request line and the fields, and where the head ends', () => {
    const text = 'GET http://app.test/x HTTP/1.1\r\nHost: app.test\r\nX-A:  one \r\n\r\nbody';
    expect(readRequestHead(bytes(text))).toEqual({
      kind: 'head',
      head: {
        method: 'GET',
        target: 'http://app.test/x',
        version: 'HTTP/1.1',
        fields: [
          { name: 'Host', value: 'app.test' },
          { name: 'X-A', value: 'one' },
        ],
        length: text.length - 4,
      },
    });
  });

  test('waits for the rest of a head, up to its limit', () => {
    expect(refusal('GET http://app.test/ HTTP/1.1\r\nHost: app.test\r\n')).toBe('incomplete');
    expect(refusal(`GET http://app.test/ HTTP/1.1\r\nX: ${'a'.repeat(MAX_HEAD_BYTES)}`)).toEqual([
      431,
      `the request head is longer than ${MAX_HEAD_BYTES} bytes`,
    ]);
  });

  test('refuses what two parsers could read two ways', () => {
    expect(refusal('GET http://app.test/ HTTP/1.1\nHost: app.test\r\n\r\n')).toEqual([
      400,
      'a line of the request head does not end in CRLF',
    ]);
    expect(refusal('GET http://app.test/ HTTP/1.1\r\nX: a\r\n b\r\n\r\n')).toEqual([
      400,
      'a field line is folded onto the next',
    ]);
    expect(refusal('GET http://app.test/ HTTP/1.1\r\nX : a\r\n\r\n')).toEqual([
      400,
      'a field line is not a name and a value',
    ]);
    expect(refusal('GET http://app.test/ HTTP/1.1\r\nX: a\x00b\r\n\r\n')).toEqual([
      400,
      'a field line is not a name and a value',
    ]);
    expect(refusal('GET  http://app.test/ HTTP/1.1\r\n\r\n')).toEqual([
      400,
      'the request line is not one of HTTP/1.1',
    ]);
    expect(refusal('GET http://app.test/ HTTP/2.0\r\n\r\n')).toEqual([
      400,
      'the request line is not one of HTTP/1.1',
    ]);
  });
});

describe('a CONNECT target', () => {
  test('is a host name and a port', () => {
    expect(connectTarget('App.Test.:443')).toEqual({ host: 'app.test', port: 443 });
    expect(connectTarget('app.test')).toBe('a CONNECT names a host and a port, as app.example:443');
    expect(connectTarget('[::1]:443')).toBe(
      'a CONNECT names a host and a port, as app.example:443',
    );
    expect(connectTarget('203.0.113.7:443')).toBe(
      'the proxy reaches hosts by name, not by address',
    );
    expect(connectTarget('app.test:0')).toBe('the request names an invalid port');
    expect(connectTarget('app.test:65536')).toBe('the request names an invalid port');
    expect(connectTarget('a..b:443')).toBe('the request does not name a host');
  });
});

describe('a plain HTTP request through the proxy', () => {
  test('is rebuilt in origin form, with what was validated and Connection: close', () => {
    expect(
      plain(
        'POST http://App.Test:8080/up?x=1 HTTP/1.1\r\nHost: app.test:8080\r\nProxy-Authorization: Basic abc\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nKeep-Alive: 5\r\nTE: trailers\r\nAccept: */*\r\nContent-Length: 0005\r\nExpect: 100-continue\r\n\r\n',
      ),
    ).toEqual({
      authority: { host: 'app.test', port: 8080 },
      head: 'POST /up?x=1 HTTP/1.1\r\nAccept: */*\r\nExpect: 100-continue\r\nHost: app.test:8080\r\nContent-Length: 5\r\nConnection: close\r\n\r\n',
      bodyLength: 5,
    });
    expect(plain('GET http://app.test HTTP/1.0\r\nHost: app.test:80\r\n\r\n')).toEqual({
      authority: { host: 'app.test', port: 80 },
      head: 'GET / HTTP/1.0\r\nHost: app.test\r\nConnection: close\r\n\r\n',
      bodyLength: 0,
    });
  });

  test('refuses a Connection field that names a field, which dropping would reframe', () => {
    for (const named of ['Content-Length', 'Host', 'close, X-Forwarded-For']) {
      expect(
        plain(
          `POST http://app.test/ HTTP/1.1\r\nHost: app.test\r\nConnection: ${named}\r\nContent-Length: 4\r\n\r\n`,
        ),
      ).toEqual([400, 'the Connection field may only say close or keep-alive']);
    }
  });

  test('refuses a Host that is not the URL, or given twice, or missing', () => {
    const reason = [400, 'the Host field must be the host and port of the URL, once'];
    expect(plain('GET http://app.test/ HTTP/1.1\r\nHost: other.test\r\n\r\n')).toEqual(reason);
    expect(plain('GET http://app.test/ HTTP/1.1\r\nHost: app.test:81\r\n\r\n')).toEqual(reason);
    expect(
      plain('GET http://app.test/ HTTP/1.1\r\nHost: app.test\r\nHost: app.test\r\n\r\n'),
    ).toEqual(reason);
    expect(plain('GET http://app.test/ HTTP/1.1\r\n\r\n')).toEqual(reason);
  });

  test('refuses a body it could not count exactly', () => {
    const request = (fields: string) =>
      plain(`POST http://app.test/ HTTP/1.1\r\nHost: app.test\r\n${fields}\r\n`);
    const once = [400, 'the Content-Length field must be one number, once'];
    expect(request('Content-Length: 4\r\nContent-Length: 4\r\n')).toEqual(once);
    expect(request('Content-Length: 4, 4\r\n')).toEqual(once);
    expect(request('Content-Length: -1\r\n')).toEqual(once);
    expect(request(`Content-Length: ${'9'.repeat(32)}\r\n`)).toEqual(once);
    expect(request(`Content-Length: ${1024 ** 3 + 1}\r\n`)).toEqual([
      413,
      `a body may hold ${1024 ** 3} bytes at most`,
    ]);
    expect(request('Transfer-Encoding: chunked\r\n')).toEqual([
      501,
      'a body goes with Content-Length, not Transfer-Encoding',
    ]);
    expect(request('Upgrade: websocket\r\n')).toEqual([
      501,
      'the proxy does not upgrade a connection',
    ]);
    expect(request('Expect: something\r\n')).toEqual([
      417,
      'the only expectation the proxy passes on is 100-continue',
    ]);
  });

  test('takes a URL by name only, and https by CONNECT', () => {
    expect(plain('GET http://203.0.113.7/ HTTP/1.1\r\nHost: 203.0.113.7\r\n\r\n')).toEqual([
      400,
      'the proxy reaches hosts by name, not by address',
    ]);
    expect(plain('GET https://app.test/ HTTP/1.1\r\nHost: app.test\r\n\r\n')).toEqual([
      400,
      'an https URL goes through the proxy with CONNECT',
    ]);
    expect(plain('GET /x HTTP/1.1\r\nHost: app.test\r\n\r\n')).toEqual([
      400,
      'a request to the proxy names an http URL in full',
    ]);
    expect(plain('GET http://user@app.test/ HTTP/1.1\r\nHost: app.test\r\n\r\n')).toEqual([
      400,
      'a request to the proxy names an http URL in full',
    ]);
  });
});
