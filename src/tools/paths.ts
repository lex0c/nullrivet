import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

// `cwd` is only the base for relative paths. Absolute paths, `..` and paths outside the project
// are accepted on purpose: access is bounded by the operating system, not by this tool layer.
export const resolvePath = (input: string, cwd: string): string => {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
};
