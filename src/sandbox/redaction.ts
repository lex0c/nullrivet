import { AGENT_SECRET_ENV_KEYS } from '../tools/env.ts';

// Credentials taken out of what the evidence log records of a call. The secrets the host holds go
// by exact match wherever they appear; in a call's arguments, credentials it may carry go by
// pattern too, as best effort: the evidence directory is to be handled as sensitive all the same.
// Outputs are kept as produced, since they are the findings.

export interface Secret {
  value: string;
  what: string;
}

// Shorter values match ordinary text.
const MIN_SECRET_CHARS = 8;

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy'];

// The secrets this process holds: the providers' keys, and the password of the proxy the host
// itself goes through.
export const hostSecrets = (env: Record<string, string | undefined>): Secret[] => {
  const secrets: Secret[] = [];
  for (const name of AGENT_SECRET_ENV_KEYS) {
    const value = env[name];
    if (value !== undefined) secrets.push({ value, what: 'provider key' });
  }
  for (const name of PROXY_VARIABLES) {
    const value = env[name];
    if (value === undefined) continue;
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password !== '') secrets.push({ value: password, what: "password of the host's proxy" });
    } catch {
      // Not a URL: nothing in it to take out.
    }
  }
  return secrets.filter(({ value }) => value.length >= MIN_SECRET_CHARS);
};

const marker = (what: string): string => `[removed: ${what}]`;

// `text` with every secret's value replaced by a marker naming what it was.
export const redactExact = (text: string, secrets: readonly Secret[]): string => {
  let result = text;
  // The longest first, so that one secret holding another is removed whole.
  for (const { value, what } of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (value.length >= MIN_SECRET_CHARS) result = result.split(value).join(marker(what));
  }
  return result;
};

const OPTIONS = 'password|passwd|token|api-key|apikey|secret|client-secret';

const PATTERNS: readonly { pattern: RegExp; replace: (...groups: string[]) => string }[] = [
  {
    // An Authorization header's value, to the end of its line or quote.
    pattern: /\b((?:proxy-)?authorization)(\s*:\s*)([^\r\n'"]+)/gi,
    replace: (_, name, separator) => `${name}${separator}${marker(`${name} value`)}`,
  },
  {
    // The password of a URL's user.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]+)@/gi,
    replace: (_, before) => `${before}${marker('password in URL')}@`,
  },
  {
    // An option's value, given after a space or an equals sign, quoted or not.
    pattern: new RegExp(`(--(?:${OPTIONS}))(=|\\s+)("[^"]*"|'[^']*'|[^\\s'"]+)`, 'gi'),
    replace: (_, option, separator) => `${option}${separator}${marker(`value of ${option}`)}`,
  },
  {
    // A user and password given as curl's -u or --user.
    pattern: /((?:^|\s)(?:-u|--user)(?:\s+|=))(['"]?)([^\s:'"]+):([^\s'"]+)\2/g,
    replace: (_, option, quote, user) => `${option}${quote}${user}:${marker('password')}${quote}`,
  },
  {
    // A credential in a query string.
    pattern: /([?&](password|token|api_key)=)([^&\s'"#]+)/gi,
    replace: (_, before, name) => `${before}${marker(`value of ${name}`)}`,
  },
];

// `text` with the host's secrets and the credentials the patterns recognize taken out.
export const redactText = (text: string, secrets: readonly Secret[]): string =>
  PATTERNS.reduce(
    (result, { pattern, replace }) =>
      result.replace(pattern, (...match) => replace(...(match.slice(0, -2) as string[]))),
    redactExact(text, secrets),
  );

// Every string in `value`, recursively, passed through `redact`.
export const redactStrings = (value: unknown, redact: (text: string) => string): unknown => {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]),
    );
  }
  return value;
};
