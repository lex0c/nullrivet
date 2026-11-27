import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { errorMessage } from '../../errors.ts';
import {
  type LookupAll,
  normalizedHost,
  type ProxiedName,
  proxyRefusal,
  withTimeout,
} from '../engagement.ts';
import { type ClientHello, MAX_CLIENT_HELLO_BYTES, readClientHello } from './client-hello.ts';
import {
  type Authority,
  connectTarget,
  fieldValues,
  MAX_HEAD_BYTES,
  plainRequest,
  type RequestHead,
  readRequestHead,
} from './http-request.ts';
import { parseNetwork, type Scope } from './ruleset.ts';

// The proxy through which the sandbox reaches the names the engagement authorizes by name. It
// authorizes connections: a tunnel whose CONNECT names the host and whose TLS ClientHello names
// the same server, or one plain HTTP request whose URL and Host name it. It cannot see the
// requests inside TLS, which HTTP/2 may send to another authority on the same connection.
//
// Each connection is checked whole before a byte reaches the target: the client's credential, the
// window, the name and port, every address the name resolves to, and the rate. The connection
// goes to the address that was checked, never to the name. What it relays is checked against the
// window chunk by chunk, so that nothing passes after the end even when the process was held.

export interface ProxyPolicy {
  // The password of the proxy's user, which only the sandbox is given.
  token: string;
  // Each name with its ports; absent, every port.
  names: readonly Pick<ProxiedName, 'host' | 'ports'>[];
  // What the sandbox reaches without the proxy: a name of the proxy must not resolve into it.
  direct: Scope;
  window?: { from: Date; until: Date };
  newConnectionsPerSecond?: number;
}

export type ProxyEvent =
  | { type: 'connected'; host: string; port: number; address: string }
  // `direct` when the name resolved to an address the scope authorizes directly: the sandbox
  // reaches the name there without the proxy, which the operator is told.
  | { type: 'refused'; reason: string; direct?: boolean };

export interface ProxyDependencies {
  resolve: LookupAll;
  // A connection to an address, never to a name.
  connect: (address: string, port: number) => Socket;
  now: () => number;
  ownAddresses: () => readonly string[];
  report: (event: ProxyEvent) => void;
}

export interface ProxyLimits {
  connections: number;
  headMs: number;
  resolveMs: number;
  connectMs: number;
  helloMs: number;
  // Without a byte in either direction for this long, a connection is closed.
  idleMs: number;
  sweepMs: number;
}

export const PROXY_LIMITS: ProxyLimits = {
  connections: 256,
  headMs: 10_000,
  resolveMs: 10_000,
  connectMs: 10_000,
  helloMs: 10_000,
  idleMs: 300_000,
  sweepMs: 1_000,
};

export const PROXY_USER = 'nullrivet';
// The port of the sandbox's loopback that leads to the proxy.
export const PROXY_PORT = 3128;
const END_OF_HEAD = Buffer.from('\r\n\r\n');
// As many addresses as the kernel's meter holds; past them, a new address is refused.
const MAX_METERED = 65_536;

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  407: 'Proxy Authentication Required',
  413: 'Content Too Large',
  417: 'Expectation Failed',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  501: 'Not Implemented',
  502: 'Bad Gateway',
};

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly fields = '',
    readonly direct = false,
  ) {
    super(reason);
  }
}

// One connection from the sandbox, and the one to the target once it is open.
interface Pair {
  client: Socket;
  upstream?: Socket;
  active: number;
}

type Read<T> = { kind: 'incomplete' } | { kind: 'refused'; status?: number; reason: string } | T;

export class ScopeProxy {
  private readonly pairs = new Set<Pair>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly ports = new Map<string, readonly number[] | undefined>();
  private readonly expected: Buffer;
  private readonly sweep: ReturnType<typeof setInterval>;
  private direct: Scope;
  private closed = false;
  // Lookups the resolver has not answered, which neither a client that left nor the time the proxy
  // waits ends.
  private lookups = 0;

  private constructor(
    private readonly server: Server,
    private readonly policy: ProxyPolicy,
    private readonly deps: ProxyDependencies,
    private readonly limits: ProxyLimits,
  ) {
    this.direct = policy.direct;
    this.expected = Buffer.from(`${PROXY_USER}:${policy.token}`);
    // A name given more than once is authorized on the ports of all its entries.
    for (const { host, ports } of policy.names) {
      if (this.ports.has(host) && this.ports.get(host) === undefined) continue;
      this.ports.set(
        host,
        ports === undefined ? undefined : [...new Set([...(this.ports.get(host) ?? []), ...ports])],
      );
    }
    server.on('connection', (client) => {
      void this.serve(client);
    });
    this.sweep = setInterval(() => this.tidy(), limits.sweepMs);
    this.sweep.unref();
  }

  // Listens on the loopback, on a port the system chooses.
  static listen(
    policy: ProxyPolicy,
    deps: ProxyDependencies,
    limits: ProxyLimits = PROXY_LIMITS,
  ): Promise<ScopeProxy> {
    const server = createServer({ allowHalfOpen: true });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        // An error accepting a connection, as when descriptors run out, costs that connection
        // only: told, it does not end the proxy and with it the sandbox's network.
        server.on('error', (error) =>
          deps.report({
            type: 'refused',
            reason: `the proxy could not accept a connection: ${errorMessage(error)}`,
          }),
        );
        resolve(new ScopeProxy(server, policy, deps, limits));
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    return address !== null && typeof address === 'object' ? address.port : 0;
  }

  get connections(): number {
    return this.pairs.size;
  }

  // The scope a refresh put in force.
  setDirect(direct: Scope): void {
    this.direct = direct;
  }

  // Ends every connection and stops listening, for good.
  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweep);
    for (const pair of this.pairs) this.end(pair);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private outside(): boolean {
    if (this.closed) return true;
    const { window } = this.policy;
    if (window === undefined) return false;
    const now = this.deps.now();
    return now < window.from.getTime() || now >= window.until.getTime();
  }

  private ended(): boolean {
    const { window } = this.policy;
    return window !== undefined && this.deps.now() >= window.until.getTime();
  }

  private tidy(): void {
    if (this.ended()) {
      for (const pair of this.pairs) this.end(pair);
      return;
    }
    const now = this.deps.now();
    for (const pair of this.pairs) {
      if (now - pair.active >= this.limits.idleMs) this.end(pair);
    }
    const rate = this.policy.newConnectionsPerSecond;
    if (rate !== undefined) {
      for (const [address, bucket] of this.buckets) {
        if (bucket.tokens + ((now - bucket.at) * rate) / 1000 >= rate) this.buckets.delete(address);
      }
    }
  }

  private end(pair: Pair): void {
    this.pairs.delete(pair);
    pair.client.destroy();
    pair.upstream?.destroy();
  }

  private refuse(pair: Pair, refusal: Refused): void {
    this.deps.report({
      type: 'refused',
      reason: refusal.reason,
      ...(refusal.direct ? { direct: true } : {}),
    });
    const body = `nullrivet proxy: ${refusal.reason}\n`;
    const response = [
      `HTTP/1.1 ${refusal.status} ${STATUS_TEXT[refusal.status] ?? 'Error'}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      ...(refusal.fields === '' ? [] : [refusal.fields]),
      '',
      body,
    ].join('\r\n');
    pair.upstream?.destroy();
    pair.client.end(response, () => this.end(pair));
  }

  private async serve(client: Socket): Promise<void> {
    if (
      this.closed ||
      this.pairs.size >= this.limits.connections ||
      this.lookups >= this.limits.connections
    ) {
      client.destroy();
      return;
    }
    const pair: Pair = { client, active: this.deps.now() };
    this.pairs.add(pair);
    client.on('error', () => this.end(pair));
    client.on('close', () => this.end(pair));
    try {
      const { value: head, bytes } = await this.collect(
        pair,
        client,
        Buffer.alloc(0),
        (data): Read<{ kind: 'head'; head: RequestHead }> => readRequestHead(data),
        // The head ends at the first empty line, looked for only in what is new.
        (data, previous) => data.indexOf(END_OF_HEAD, Math.max(0, previous - 3)) !== -1,
        MAX_HEAD_BYTES,
        this.limits.headMs,
      );
      const rest = bytes.subarray(head.head.length);
      this.authenticate(head.head);
      if (this.outside()) throw new Refused(403, 'the engagement window is not open');
      if (head.head.method === 'CONNECT') await this.tunnel(pair, head.head, rest);
      else await this.forward(pair, head.head, rest);
    } catch (error) {
      if (!this.pairs.has(pair)) return;
      if (error instanceof Refused) this.refuse(pair, error);
      else this.end(pair);
    }
  }

  private authenticate(head: RequestHead): void {
    const given = fieldValues(head, 'proxy-authorization');
    const match =
      given.length === 1 ? /^basic +([A-Za-z0-9+/=]+)$/i.exec(given[0] as string) : null;
    const credential = match === null ? null : Buffer.from(match[1] as string, 'base64');
    if (
      credential === null ||
      credential.length !== this.expected.length ||
      !timingSafeEqual(credential, this.expected)
    ) {
      throw new Refused(
        407,
        'the proxy takes the credential the sandbox was given',
        'Proxy-Authenticate: Basic realm="nullrivet"',
      );
    }
  }

  // Reads from the client until `read` has what it needs, holding at most `limit` bytes, for at
  // most `ms`. What comes is copied once into a buffer of the limit, and `read` runs only when
  // `ready` sees, past what it saw before, that it may have it: a client can send one byte at a
  // time, and reading all that came for each would cost the square of it. The client is paused
  // again after, so that nothing it sends next is lost.
  private collect<T extends { kind: string }>(
    pair: Pair,
    socket: Socket,
    first: Buffer,
    read: (bytes: Uint8Array) => Read<T>,
    ready: (bytes: Buffer, previous: number) => boolean,
    limit: number,
    ms: number,
  ): Promise<{ value: T; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      const store = Buffer.allocUnsafe(limit);
      let length = 0;
      const past: Buffer[] = [];
      const take = (chunk: Buffer): number => {
        const previous = length;
        const fits = Math.min(limit - length, chunk.length);
        chunk.copy(store, length, 0, fits);
        length += fits;
        if (fits < chunk.length) past.push(chunk.subarray(fits));
        return previous;
      };
      const done = (outcome: () => void): void => {
        clearTimeout(timer);
        socket.pause();
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('close', onEnd);
        outcome();
      };
      const attempt = (previous: number): boolean => {
        const bytes = store.subarray(0, length);
        if (length < limit && !ready(bytes, previous)) return false;
        const result = read(bytes);
        if (result.kind === 'incomplete') {
          if (length < limit) return false;
          done(() => reject(new Refused(400, 'the request is longer than the proxy reads')));
          return true;
        }
        if (result.kind === 'refused') {
          const { status, reason } = result as { status?: number; reason: string };
          done(() => reject(new Refused(status ?? 400, reason)));
          return true;
        }
        done(() => resolve({ value: result as T, bytes: Buffer.concat([bytes, ...past]) }));
        return true;
      };
      const onData = (chunk: Buffer): void => {
        pair.active = this.deps.now();
        attempt(take(chunk));
      };
      const onEnd = (): void => done(() => reject(new Error('the client ended')));
      socket.once('close', onEnd);
      const timer = setTimeout(
        () => done(() => reject(new Refused(400, 'the client did not send in time'))),
        ms,
      );
      if (first.length > 0 && attempt(take(first))) return;
      socket.on('data', onData);
      socket.on('end', onEnd);
      socket.resume();
    });
  }

  private authorize(target: Authority): void {
    if (!this.ports.has(target.host)) {
      throw new Refused(403, `${target.host} is not reached through the proxy`);
    }
    const ports = this.ports.get(target.host);
    if (ports !== undefined && !ports.includes(target.port)) {
      throw new Refused(403, `port ${target.port} of ${target.host} is not authorized`);
    }
  }

  private admit(address: string): boolean {
    const rate = this.policy.newConnectionsPerSecond;
    if (rate === undefined) return true;
    const now = this.deps.now();
    let bucket = this.buckets.get(address);
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_METERED) return false;
      bucket = { tokens: rate, at: now };
      this.buckets.set(address, bucket);
    }
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) * rate) / 1000);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // Resolves the name, checks every address it gave, and connects to the first that answers, all
  // within the connection's time. A lookup counts against the connections until the resolver
  // answers, the client gone or not, past the time the proxy waits for it: it cannot be cancelled.
  private async open(pair: Pair, target: Authority): Promise<Socket> {
    const { host, port } = target;
    let found: string[];
    this.lookups += 1;
    const lookup = this.deps.resolve(host);
    const settled = (): void => {
      this.lookups -= 1;
    };
    lookup.then(settled, settled);
    try {
      found = await withTimeout(lookup, this.limits.resolveMs, 'the resolver did not answer');
    } catch {
      throw new Refused(502, `${host} could not be resolved`);
    }
    if (!this.pairs.has(pair)) throw new Error('the client left');
    const addresses = [...new Set(found.filter((address) => parseNetwork(address) !== null))];
    if (addresses.length === 0) throw new Refused(502, `${host} resolves to no address`);
    const own = this.deps.ownAddresses();
    const refuse = (address: string): void => {
      const refusal = proxyRefusal(this.direct, address, port, own);
      if (refusal !== null) {
        throw new Refused(
          403,
          `${host} resolves to ${address}, ${refusal.why}`,
          '',
          refusal.direct,
        );
      }
    };
    for (const address of addresses) refuse(address);
    const deadline = Date.now() + this.limits.connectMs;
    for (const address of addresses) {
      if (this.outside()) throw new Refused(403, 'the engagement window is not open');
      // Checked again: a refresh can change the scope while an earlier address is tried.
      refuse(address);
      const left = deadline - Date.now();
      if (left <= 0) break;
      if (!this.admit(address)) {
        throw new Refused(429, `the rate of new connections to ${address} is reached`);
      }
      const upstream = this.deps.connect(address, port);
      pair.upstream = upstream;
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), left);
        const settle = (outcome: boolean) => () => {
          clearTimeout(timer);
          resolve(outcome);
        };
        upstream.once('connect', settle(true));
        upstream.once('error', settle(false));
        upstream.once('close', settle(false));
      });
      if (!this.pairs.has(pair)) {
        upstream.destroy();
        throw new Error('the client left');
      }
      if (connected) {
        upstream.on('error', () => this.end(pair));
        upstream.on('close', () => this.end(pair));
        this.deps.report({ type: 'connected', host, port, address });
        return upstream;
      }
      upstream.destroy();
      delete pair.upstream;
    }
    throw new Refused(502, `${host} did not accept a connection on port ${port}`);
  }

  private async tunnel(pair: Pair, head: RequestHead, rest: Buffer): Promise<void> {
    const target = connectTarget(head.target);
    if (typeof target === 'string') throw new Refused(400, target);
    this.authorize(target);
    const upstream = await this.open(pair, target);
    pair.client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    // Past the 200, a refusal closes the tunnel: the client speaks TLS now.
    const { value: hello, bytes } = await this.collect<Extract<ClientHello, { kind: 'hello' }>>(
      pair,
      pair.client,
      rest,
      (data) => readClientHello(data),
      // An incomplete record costs readClientHello its first five bytes only.
      () => true,
      MAX_CLIENT_HELLO_BYTES,
      this.limits.helloMs,
    ).catch((error: unknown) => {
      const reason = error instanceof Refused ? error.reason : 'the client ended';
      this.deps.report({ type: 'refused', reason: `the tunnel to ${target.host}: ${reason}` });
      this.end(pair);
      throw new Error(reason);
    });
    const named = normalizedHost(hello.serverName);
    if (!('name' in named) || named.name !== target.host) {
      this.deps.report({
        type: 'refused',
        reason: `the tunnel to ${target.host} names another server in its ClientHello`,
      });
      this.end(pair);
      return;
    }
    this.relay(pair, pair.client, upstream, bytes);
    this.relay(pair, upstream, pair.client);
  }

  private async forward(pair: Pair, head: RequestHead, rest: Buffer): Promise<void> {
    const request = plainRequest(head);
    if (!('head' in request)) throw new Refused(request.status, request.reason);
    this.authorize(request.authority);
    const upstream = await this.open(pair, request.authority);
    if (this.pass(pair, upstream, request.head) === 'ended') return;
    // The answer is relayed from now on, so that a 100 Continue reaches the client.
    this.relay(pair, upstream, pair.client);
    this.relay(pair, pair.client, upstream, rest, request.bodyLength);
  }

  // Writes a chunk if the window still allows it, and says whether the other side's buffer is
  // full; past the window, ends every connection instead.
  private pass(pair: Pair, to: Socket, chunk: Buffer): 'sent' | 'full' | 'ended' {
    if (this.outside()) {
      for (const each of this.pairs) this.end(each);
      return 'ended';
    }
    pair.active = this.deps.now();
    return to.write(chunk) ? 'sent' : 'full';
  }

  // Relays from one side to the other, checking the window before each chunk and pausing the
  // source while the other side's buffer is full. With a budget, exactly that many bytes pass and
  // the source is not read further.
  private relay(pair: Pair, from: Socket, to: Socket, first?: Buffer, budget?: number): void {
    let left = budget ?? Number.POSITIVE_INFINITY;
    // Paused until the other side drains: one wait at a time, which nothing resumes early.
    let waiting = false;
    const send = (chunk: Buffer): void => {
      const part = left === Number.POSITIVE_INFINITY ? chunk : chunk.subarray(0, left);
      left -= part.length;
      if (part.length > 0 && this.pass(pair, to, part) === 'full' && !waiting) {
        waiting = true;
        from.pause();
        to.once('drain', () => {
          waiting = false;
          if (left > 0 && this.pairs.has(pair)) from.resume();
        });
      }
      if (left === 0) stop();
    };
    const onEnd = (): void => {
      if (this.pairs.has(pair)) to.end();
    };
    const stop = (): void => {
      from.pause();
      from.off('data', send);
      from.off('end', onEnd);
    };
    if (first !== undefined && first.length > 0) send(first);
    if (left <= 0 || !this.pairs.has(pair)) return;
    from.on('data', send);
    from.on('end', onEnd);
    if (!waiting) from.resume();
  }
}
