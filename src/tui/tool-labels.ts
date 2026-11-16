import { stripAnsi } from '../sanitize/ansi.ts';

const VERBS: Record<string, { running: string; done: string }> = {
  read_file: { running: 'Reading', done: 'Read' },
  write_file: { running: 'Writing', done: 'Wrote' },
  edit_file: { running: 'Editing', done: 'Edited' },
  bash: { running: 'Running', done: 'Ran' },
  git: { running: 'Inspecting', done: 'Inspected' },
};

export const toolVerb = (name: string, phase: 'running' | 'done'): string =>
  VERBS[name]?.[phase] ?? (phase === 'running' ? `Calling ${name}` : `Called ${name}`);

// Tool arguments come from the model, so they are flattened to one line without control bytes
// before being shown.
export const oneLine = (value: string, max: number): string => {
  const flat = stripAnsi(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
};

export const toolSubject = (name: string, args: Record<string, unknown>, max = 120): string => {
  const str = (key: string): string | undefined =>
    typeof args[key] === 'string' ? (args[key] as string) : undefined;
  switch (name) {
    case 'bash':
      return oneLine(str('command') ?? '', max);
    case 'git': {
      const paths = Array.isArray(args.paths)
        ? (args.paths as unknown[]).filter((p) => typeof p === 'string')
        : [];
      const parts = [
        str('subcommand'),
        str('ref'),
        str('base'),
        str('target'),
        str('path'),
        ...paths,
      ];
      return oneLine(parts.filter((p) => p !== undefined && p !== '').join(' '), max);
    }
    default:
      return oneLine(str('path') ?? '', max);
  }
};

// First line of an error result, without the code prefix the model sees.
export const errorSummary = (content: string, max = 160): string => {
  const first = content.split('\n')[0] ?? '';
  return oneLine(first.replace(/^error \[[^\]]+\]: /, ''), max);
};
