import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

// `cwd` is only the base for relative paths. Absolute paths, `..` and paths outside the project
// are accepted on purpose: access is bounded by the operating system, not by this tool layer.
export const resolvePath = (input: string, cwd: string): string => {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
};

// Paths shown to the model are relative to the working directory when they are inside it, so
// they can be passed back to other tools as is; other paths stay absolute.
export const displayPath = (abs: string, cwd: string): string => {
  const rel = relative(cwd, abs);
  return rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? abs : rel;
};

// Whether `path` is `dir` or inside it. Both must be absolute, with symbolic links resolved when
// the answer has to hold for the files they name.
export const isWithinDirectory = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};

// The `path` argument of a file tool, when it is usable; invalid input is reported by the tool.
export const pathArgument = (input: Record<string, unknown>, cwd: string): string[] =>
  typeof input.path === 'string' && input.path.length > 0 ? [resolvePath(input.path, cwd)] : [];
