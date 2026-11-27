import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, isIP, connect as netConnect, type Server, Socket } from 'node:net';
import {
  PROXY_LIMITS,
  type ProxyEvent,
  type ProxyLimits,
  type ProxyPolicy,
  ScopeProxy,
} from '../../src/sandbox/network/proxy.ts';
import { type Network, parseNetwork } from '../../src/sandbox/network/ruleset.ts';
import { captureClientHello } from '../helpers/client-hello.ts';

const net = (text: string): Network => parseNetwork(text) as Network;
const TOKEN = 'a'.repeat(64);
const AUTH = `Proxy-Authorization: Basic ${Buffer.from(`nullrivet:${TOKEN}`).toString('base64')}`;

// A target that records what each connection sent it, and answers as `answer` says.
interface Upstream {
  port: number;
  received: Buffer[];
  server: Server;
}
const upstreams: Upstream[] = [];
const startUpstream = (answer?: (socket: Socket, bytes: Buffer) => void): Promise<Upstream> =>
  new Promise((resolve) => {
    const received: Buffer[] = [];
    const server = createServer((socket) => {
      const index = received.push(Buffer.alloc(0)) - 1;
      socket.on('data', (chunk: Buffer) => {
        received[index] = Buffer.concat([received[index] as Buffer, chunk]);
        answer?.(socket, received[index] as Buffer);
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      const upstream = { port: address.port, received, server };
      upstreams.push(upstream);
      resolve(upstream);
    });
  });

const proxies: ScopeProxy[] = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const upstream of upstreams.splice(0)) upstream.server.close();
});

interface Setup {
  proxy: ScopeProxy;
  upstream: Upstream;
  events: ProxyEvent[];
  dialed: string[];
  clock: { now: number };
}

const setUp = async (
  options: {
    policy?: Partial<ProxyPolicy>;
    answers?: Record<string, string[]>;
    answer?: (socket: Socket, bytes: Buffer) => void;
    limits?: Partial<ProxyLimits>;
    resolve?: (host: string) => Promise<string[]>;
    connect?: (address: string, port: number, target: number) => Socket;
  } = {},
): Promise<Setup> => {
  const upstream = await startUpstream(options.answer);
  const events: ProxyEvent[] = [];
  const dialed: string[] = [];
  const clock = { now: Date.parse('2026-11-20T12:00:00Z') };
  const answers = options.answers ?? { 'app.test': ['198.51.100.7'] };
  const proxy = await ScopeProxy.listen(
    {
      token: TOKEN,
      names: [{ host: 'app.test', ports: [443, 80] }],
      direct: { allow: [], deny: [] },
      ...options.policy,
    },
    {
      resolve: options.resolve ?? (async (host) => answers[host] ?? []),
      // Every target is the local one: the test records which address was asked for.
      connect: (address, port) => {
        dialed.push(`${address} ${port}`);
        return (
          options.connect?.(address, port, upstream.port) ??
          netConnect({ host: '127.0.0.1', port: upstream.port, allowHalfOpen: true })
        );
      },
      now: () => clock.now,
      ownAddresses: () => [],
      report: (event) => events.push(event),
    },
    { ...PROXY_LIMITS, ...options.limits },
  );
  proxies.push(proxy);
  return { proxy, upstream, events, dialed, clock };
};

const open = (port: number): Promise<Socket> =>
  new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.on('error', () => {});
  });

// Everything the proxy sends until it closes the connection.
const closing = (socket: Socket): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(text));
  });

const until = (socket: Socket, wanted: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(
      () => reject(new Error(`no "${wanted}" in ${JSON.stringify(text)}`)),
      5_000,
    );
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      if (text.includes(wanted)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });

const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ask = async (port: number, request: string): Promise<string> => {
  const socket = await open(port);
  const answer = closing(socket);
  socket.write(request);
  return answer;
};

// A tunnel the proxy accepted, past its 200.
const tunnel = async (port: number, target = 'app.test:443'): Promise<Socket> => {
  const socket = await open(port);
  const answered = until(socket, '\r\n\r\n');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${AUTH}\r\n\r\n`);
  expect(await answered).toBe('HTTP/1.1 200 Connection established\r\n\r\n');
  return socket;
};

const statusOf = (response: string): string => response.split('\r\n')[0] as string;
const bodyOf = (response: string): string => response.slice(response.indexOf('\r\n\r\n') + 4);

describe('the proxy of the scope', () => {
  test('takes only the credential the sandbox was given, and reaches nothing before it', async () => {
    const { proxy, upstream, dialed } = await setUp();
    for (const credential of ['', 'Proxy-Authorization: Basic bnVsbHJpdmV0Ondyb25n\r\n']) {
      const response = await ask(
        proxy.port,
        `CONNECT app.test:443 HTTP/1.1\r\nHost: app.test:443\r\n${credential}\r\n`,
      );
      expect(statusOf(response)).toBe('HTTP/1.1 407 Proxy Authentication Required');
      expect(response).toContain('Proxy-Authenticate: Basic realm="nullrivet"');
    }
    expect(dialed).toEqual([]);
    expect(upstream.received).toEqual([]);
  });

  test('refuses a name or a port it does not reach, saying which', async () => {
    const { proxy, dialed } = await setUp();
    const other = await ask(proxy.port, `CONNECT other.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
    expect(statusOf(other)).toBe('HTTP/1.1 403 Forbidden');
    expect(bodyOf(other)).toBe('nullrivet proxy: other.test is not reached through the proxy\n');
    const port = await ask(proxy.port, `CONNECT app.test:22 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
    expect(bodyOf(port)).toBe('nullrivet proxy: port 22 of app.test is not authorized\n');
    const address = await ask(proxy.port, `CONNECT 198.51.100.7:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
    expect(bodyOf(address)).toBe(
      'nullrivet proxy: the proxy reaches hosts by name, not by address\n',
    );
    expect(dialed).toEqual([]);
  });

  test('opens a tunnel to the address it checked, and relays it once the ClientHello names the host', async () => {
    const { proxy, upstream, dialed, events } = await setUp();
    const socket = await tunnel(proxy.port);
    const hello = await captureClientHello('app.test');
    socket.write(hello);
    // Past the ClientHello nothing is inspected: these bytes reach the target as they are, as a
    // request to another authority inside TLS would.
    socket.write('GET / HTTP/1.1\r\nHost: other.test\r\n\r\n');
    await settle();
    expect(dialed).toEqual(['198.51.100.7 443']);
    expect(isIP('198.51.100.7')).toBe(4);
    expect(upstream.received).toEqual([
      Buffer.concat([hello, Buffer.from('GET / HTTP/1.1\r\nHost: other.test\r\n\r\n')]),
    ]);
    expect(events).toEqual([
      { type: 'connected', host: 'app.test', port: 443, address: '198.51.100.7' },
    ]);
    socket.destroy();
  });

  test('closes a tunnel whose ClientHello names another server, or that is not TLS, sending nothing on', async () => {
    const { proxy, upstream, events } = await setUp();
    for (const first of [
      await captureClientHello('other.test'),
      Buffer.from('GET / HTTP/1.1\r\n\r\n'),
    ]) {
      const socket = await tunnel(proxy.port);
      const closed = closing(socket);
      socket.write(first);
      expect(await closed).toBe('');
    }
    await settle();
    expect(upstream.received.every((bytes) => bytes.length === 0)).toBe(true);
    expect(events.filter((event) => event.type === 'refused')).toEqual([
      { type: 'refused', reason: 'the tunnel to app.test names another server in its ClientHello' },
      {
        type: 'refused',
        reason: 'the tunnel to app.test: the tunnel does not start with a TLS handshake',
      },
    ]);
  });

  test('sends one plain request on, rebuilt, with exactly its body, and relays the answer', async () => {
    const { proxy, upstream } = await setUp({
      answer: (socket, bytes) => {
        if (bytes.includes('abcd')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
      },
    });
    // A second request in the same chunk, as a pipelined one, never reaches the target.
    const response = await ask(
      proxy.port,
      `POST http://app.test/up HTTP/1.1\r\nHost: app.test\r\n${AUTH}\r\nContent-Length: 4\r\n\r\nabcdGET http://app.test/other HTTP/1.1\r\nHost: app.test\r\n\r\n`,
    );
    expect(response).toBe('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    expect(upstream.received.map((bytes) => bytes.toString('latin1'))).toEqual([
      'POST /up HTTP/1.1\r\nHost: app.test\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd',
    ]);
  });

  test('refuses a Connection field that names a field, before reaching the target', async () => {
    const { proxy, upstream, dialed } = await setUp();
    for (const named of ['Content-Length', 'Host']) {
      const response = await ask(
        proxy.port,
        `POST http://app.test/ HTTP/1.1\r\nHost: app.test\r\n${AUTH}\r\nConnection: ${named}\r\nContent-Length: 45\r\n\r\n${'x'.repeat(45)}`,
      );
      expect(statusOf(response)).toBe('HTTP/1.1 400 Bad Request');
    }
    expect(dialed).toEqual([]);
    expect(upstream.received).toEqual([]);
  });

  test('passes a 100 Continue on, so that the client sends its body', async () => {
    const { proxy, upstream } = await setUp({
      answer: (socket, bytes) => {
        const text = bytes.toString('latin1');
        if (text.endsWith('\r\n\r\n')) socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        if (text.endsWith('12345')) socket.end('HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n');
      },
    });
    const socket = await open(proxy.port);
    const continued = until(socket, '100 Continue\r\n\r\n');
    const created = until(socket, '201 Created');
    socket.write(
      `PUT http://app.test/f HTTP/1.1\r\nHost: app.test\r\n${AUTH}\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n`,
    );
    await continued;
    socket.write('12345');
    await created;
    expect(upstream.received[0]?.toString('latin1')).toEndWith(
      'Expect: 100-continue\r\nHost: app.test\r\nContent-Length: 5\r\nConnection: close\r\n\r\n12345',
    );
    socket.destroy();
  });

  test('refuses a name whose answer holds an internal address or one authorized directly', async () => {
    const { proxy, dialed } = await setUp({
      answers: { 'app.test': ['198.51.100.7', '10.0.0.1'] },
    });
    const internal = await ask(proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
    expect(bodyOf(internal)).toBe(
      'nullrivet proxy: app.test resolves to 10.0.0.1, not on the public internet (private)\n',
    );
    proxy.setDirect({ allow: [{ network: net('10.0.0.0/8') }], deny: [] });
    // A cidr does not make an internal address one the proxy reaches: it is still refused.
    expect(bodyOf(await ask(proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`))).toBe(
      'nullrivet proxy: app.test resolves to 10.0.0.1, not on the public internet (private)\n',
    );
    expect(dialed).toEqual([]);

    const direct = await setUp({
      answer: (socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'),
    });
    direct.proxy.setDirect({
      allow: [{ network: net('198.51.100.0/24'), ports: [443] }],
      deny: [],
    });
    expect(
      bodyOf(await ask(direct.proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`)),
    ).toBe(
      'nullrivet proxy: app.test resolves to 198.51.100.7, authorized directly on port 443, so reached without the proxy\n',
    );
    // On another port the address is not reached directly.
    const other = await ask(
      direct.proxy.port,
      `GET http://app.test/ HTTP/1.1\r\nHost: app.test\r\n${AUTH}\r\n\r\n`,
    );
    expect(statusOf(other)).not.toBe('HTTP/1.1 403 Forbidden');
    expect(direct.dialed).toEqual(['198.51.100.7 80']);
  });

  test('holds new connections to an address to the rate', async () => {
    const { proxy, clock } = await setUp({ policy: { newConnectionsPerSecond: 2 } });
    const statuses: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const socket = await open(proxy.port);
      const answer = until(socket, '\r\n\r\n');
      socket.write(`CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
      statuses.push(statusOf(await answer));
      socket.destroy();
    }
    expect(statuses).toEqual([
      'HTTP/1.1 200 Connection established',
      'HTTP/1.1 200 Connection established',
      'HTTP/1.1 429 Too Many Requests',
    ]);
    clock.now += 500;
    const socket = await tunnel(proxy.port);
    socket.destroy();
  });

  test('takes so many connections at once, and closes the idle ones', async () => {
    const { proxy, clock } = await setUp({ limits: { connections: 3, idleMs: 200, sweepMs: 20 } });
    const idle = await Promise.all([open(proxy.port), open(proxy.port), open(proxy.port)]);
    const closed = idle.map(closing);
    await settle(50);
    const extra = await open(proxy.port);
    expect(await closing(extra)).toBe('');
    expect(proxy.connections).toBe(3);
    await settle(50);
    expect(proxy.connections).toBe(3);
    clock.now += 200;
    expect(await Promise.all(closed)).toEqual(['', '', '']);
    expect(proxy.connections).toBe(0);
  });

  test('refuses outside the window, and relays nothing once its end has passed', async () => {
    const window = {
      from: new Date('2026-11-20T12:00:00Z'),
      until: new Date('2026-11-20T13:00:00Z'),
    };
    const { proxy, upstream, clock } = await setUp({ policy: { window } });
    clock.now = window.from.getTime() - 1;
    expect(bodyOf(await ask(proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`))).toBe(
      'nullrivet proxy: the engagement window is not open\n',
    );
    clock.now = window.from.getTime();
    const socket = await tunnel(proxy.port);
    const closed = closing(socket);
    const hello = await captureClientHello('app.test');
    socket.write(hello);
    await settle();
    clock.now = window.until.getTime();
    socket.write('after the end');
    await closed;
    expect(upstream.received).toEqual([Buffer.from(hello)]);
  });

  test('ends every tunnel when it closes', async () => {
    const { proxy } = await setUp();
    const socket = await tunnel(proxy.port);
    const closed = closing(socket);
    await proxy.close();
    expect(await closed).toBe('');
    expect(proxy.connections).toBe(0);
  });

  test('opens nothing for a client that left while its name was resolved', async () => {
    let answer: (addresses: string[]) => void = () => undefined;
    const { proxy, upstream, dialed } = await setUp({
      resolve: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const socket = await open(proxy.port);
    socket.write(`CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
    await settle(50);
    socket.resetAndDestroy();
    await settle(50);
    answer(['198.51.100.7']);
    await settle();
    expect(dialed).toEqual([]);
    expect(upstream.received).toEqual([]);
    expect(proxy.connections).toBe(0);
  });

  test('counts the lookups of clients that left against its connections, until the resolver answers', async () => {
    const { proxy } = await setUp({
      resolve: () => new Promise((resolve) => setTimeout(() => resolve([]), 600)),
      limits: { connections: 2, resolveMs: 200 },
    });
    for (let client = 0; client < 2; client += 1) {
      const socket = await open(proxy.port);
      socket.write(`CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`);
      await settle(30);
      socket.resetAndDestroy();
    }
    await settle(30);
    expect(proxy.connections).toBe(0);
    // Two lookups still under way, past the time the proxy waited for them: no third connection is
    // taken until the resolver answers them.
    await settle(250);
    expect(await closing(await open(proxy.port))).toBe('');
    await settle(400);
    expect(bodyOf(await ask(proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`))).toBe(
      'nullrivet proxy: app.test could not be resolved\n',
    );
  });

  test('reads a head sent one byte at a time', async () => {
    const { proxy } = await setUp();
    const socket = await open(proxy.port);
    const answer = closing(socket);
    for (const byte of `CONNECT other.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`) {
      socket.write(byte);
      await settle(1);
    }
    expect(bodyOf(await answer)).toBe(
      'nullrivet proxy: other.test is not reached through the proxy\n',
    );
  });

  test('gives all the addresses of a name one time to connect, checking each against the scope then', async () => {
    const silent = await setUp({
      answers: { 'app.test': ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4'] },
      connect: () => new Socket(),
      limits: { connectMs: 300 },
    });
    const began = Date.now();
    expect(
      statusOf(await ask(silent.proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`)),
    ).toBe('HTTP/1.1 502 Bad Gateway');
    expect(Date.now() - began).toBeLessThan(900);

    // The first address fails, and meanwhile a refresh authorizes the second one directly.
    let proxy: ScopeProxy | undefined;
    const changing = await setUp({
      answers: { 'app.test': ['198.51.100.1', '198.51.100.2'] },
      connect: (address, _port, target) => {
        if (address === '198.51.100.1') {
          proxy?.setDirect({
            allow: [{ network: net('198.51.100.2/32'), ports: [443] }],
            deny: [],
          });
          const failing = new Socket();
          setTimeout(() => failing.destroy(new Error('refused')), 10);
          return failing;
        }
        return netConnect({ host: '127.0.0.1', port: target });
      },
    });
    proxy = changing.proxy;
    expect(
      bodyOf(await ask(changing.proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`)),
    ).toBe(
      'nullrivet proxy: app.test resolves to 198.51.100.2, authorized directly on port 443, so reached without the proxy\n',
    );
    expect(changing.dialed).toEqual(['198.51.100.1 443']);
  });

  test('answers when the resolver does not', async () => {
    const { proxy, dialed } = await setUp({
      resolve: () => new Promise(() => {}),
      limits: { resolveMs: 50 },
    });
    expect(bodyOf(await ask(proxy.port, `CONNECT app.test:443 HTTP/1.1\r\n${AUTH}\r\n\r\n`))).toBe(
      'nullrivet proxy: app.test could not be resolved\n',
    );
    expect(dialed).toEqual([]);
  });
});
