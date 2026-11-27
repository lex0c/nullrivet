import { isPlainObject } from '../protocol.ts';
import type { ProxyEvent, ProxyPolicy } from './proxy.ts';
import {
  type AllowedDestination,
  isPort,
  type Network,
  parseNetwork,
  type Scope,
} from './ruleset.ts';

// The lines between the host and the proxy's process, one JSON object each, on the process's
// standard streams. The credential goes only this way: a command line and an environment are
// readable by every user of the host.
export const MAX_PROXY_LINE_BYTES = 8 * 1024 * 1024;
// Where the proxy's process finds the listening socket the host made and holds.
export const PROXY_LISTEN_FD = 4;

export type HostToProxy =
  | { type: 'policy'; policy: ProxyPolicy }
  // The direct scope a refresh put in force; the proxy answers scope.set once it holds it.
  | { type: 'scope'; direct: Scope };

export type ProxyToHost =
  | { type: 'listening'; port: number }
  | { type: 'scope.set' }
  | { type: 'error'; message: string }
  | ProxyEvent;

const isPorts = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((port) => typeof port === 'number' && isPort(port));

const network = (value: unknown): Network | null =>
  isPlainObject(value) && typeof value.address === 'string' && typeof value.prefix === 'number'
    ? parseNetwork(`${value.address}/${value.prefix}`)
    : null;

const scope = (value: unknown): Scope | null => {
  if (!isPlainObject(value) || !Array.isArray(value.allow) || !Array.isArray(value.deny))
    return null;
  const allow: AllowedDestination[] = [];
  for (const entry of value.allow) {
    const held = isPlainObject(entry) ? network(entry.network) : null;
    if (held === null || !isPlainObject(entry)) return null;
    if (entry.ports !== undefined && !isPorts(entry.ports)) return null;
    allow.push(
      entry.ports === undefined ? { network: held } : { network: held, ports: entry.ports },
    );
  }
  const deny: Network[] = [];
  for (const entry of value.deny) {
    const held = network(entry);
    if (held === null) return null;
    deny.push(held);
  }
  return { allow, deny };
};

const date = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// A line from the host. The host is trusted, but a line it did not mean to send is refused rather
// than guessed at.
export const parseHostLine = (line: string): HostToProxy | null => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (value.type === 'scope') {
    const direct = scope(value.direct);
    return direct === null ? null : { type: 'scope', direct };
  }
  if (value.type !== 'policy' || !isPlainObject(value.policy)) return null;
  const { token, names, direct, window, newConnectionsPerSecond } = value.policy;
  const held = scope(direct);
  if (typeof token !== 'string' || !/^[0-9a-f]{32,}$/.test(token) || held === null) return null;
  if (!Array.isArray(names)) return null;
  const proxied: ProxyPolicy['names'][number][] = [];
  for (const entry of names) {
    if (!isPlainObject(entry) || typeof entry.host !== 'string') return null;
    if (entry.ports !== undefined && !isPorts(entry.ports)) return null;
    proxied.push(
      entry.ports === undefined ? { host: entry.host } : { host: entry.host, ports: entry.ports },
    );
  }
  const policy: ProxyPolicy = { token, names: proxied, direct: held };
  if (window !== undefined) {
    const from = isPlainObject(window) ? date(window.from) : null;
    const until = isPlainObject(window) ? date(window.until) : null;
    if (from === null || until === null) return null;
    policy.window = { from, until };
  }
  if (newConnectionsPerSecond !== undefined) {
    if (typeof newConnectionsPerSecond !== 'number' || !Number.isInteger(newConnectionsPerSecond)) {
      return null;
    }
    policy.newConnectionsPerSecond = newConnectionsPerSecond;
  }
  return { type: 'policy', policy };
};

// A line from the proxy's process, which runs where the sandbox's traffic reaches it: what it says
// is held to the shapes it may send.
export const parseProxyLine = (line: string): ProxyToHost | null => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const text = (field: unknown): field is string =>
    typeof field === 'string' && field.length <= 4096;
  switch (value.type) {
    case 'listening':
      return Number.isInteger(value.port) &&
        (value.port as number) > 0 &&
        (value.port as number) < 65_536
        ? { type: 'listening', port: value.port as number }
        : null;
    case 'scope.set':
      return { type: 'scope.set' };
    case 'error':
      return text(value.message) ? { type: 'error', message: value.message } : null;
    case 'refused':
      if (!text(value.reason) || (value.direct !== undefined && value.direct !== true)) return null;
      return value.direct === true
        ? { type: 'refused', reason: value.reason, direct: true }
        : { type: 'refused', reason: value.reason };
    case 'authorized':
      return text(value.host) &&
        text(value.address) &&
        Number.isInteger(value.port) &&
        (value.port as number) > 0 &&
        (value.port as number) < 65_536
        ? {
            type: 'authorized',
            host: value.host,
            port: value.port as number,
            address: value.address,
          }
        : null;
    default:
      return null;
  }
};

export const encodeLine = (message: HostToProxy | ProxyToHost): string =>
  `${JSON.stringify(message)}\n`;
