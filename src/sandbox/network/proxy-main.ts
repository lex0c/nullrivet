import { connect } from 'node:net';
import { errorMessage } from '../../errors.ts';
import { hostAddresses, lookupAll } from '../engagement.ts';
import { LineSplitter } from '../lines.ts';
import { PROXY_LIMITS, ScopeProxy } from './proxy.ts';
import {
  encodeLine,
  MAX_PROXY_LINE_BYTES,
  PROXY_LISTEN_FD,
  type ProxyToHost,
  parseHostLine,
} from './proxy-wire.ts';

// The proxy's process: it takes its policy from the host on standard input, says where it listens,
// and reports each connection it opens or refuses. An end of its input ends it, every connection
// with it.
export const runProxy = (): void => {
  let proxy: ScopeProxy | null = null;
  let starting = false;
  const send = (message: ProxyToHost): void => {
    process.stdout.write(encodeLine(message));
  };
  const fail = (message: string): void => {
    send({ type: 'error', message });
    process.exit(1);
  };
  const splitter = new LineSplitter(
    MAX_PROXY_LINE_BYTES,
    (line) => {
      const message = parseHostLine(line);
      if (message === null) return fail('the host sent a malformed line');
      if (message.type === 'policy') {
        if (starting) return fail('the host sent a second policy');
        starting = true;
        ScopeProxy.listen(
          message.policy,
          {
            resolve: lookupAll,
            connect: (address, port) => connect({ host: address, port, allowHalfOpen: true }),
            now: Date.now,
            ownAddresses: hostAddresses,
            report: send,
          },
          PROXY_LIMITS,
          PROXY_LISTEN_FD,
        ).then(
          (listening) => {
            proxy = listening;
            send({ type: 'listening', port: listening.port });
          },
          (error: unknown) => fail(`the proxy cannot listen: ${errorMessage(error)}`),
        );
        return;
      }
      if (proxy === null) return fail('the host sent a scope before the proxy listened');
      proxy.setDirect(message.direct);
      send({ type: 'scope.set' });
    },
    () => fail('a line from the host exceeds the limit'),
  );
  process.stdin.on('data', (chunk: Buffer) => splitter.push(chunk));
  process.stdin.on('end', () => {
    void (proxy?.close() ?? Promise.resolve()).then(() => process.exit(0));
  });
};
