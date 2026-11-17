import { terminalText } from '../sanitize/display.ts';

const VERBS: Record<string, { running: string; done: string }> = {
  read_file: { running: 'Reading', done: 'Read' },
  write_file: { running: 'Writing', done: 'Wrote' },
  edit_file: { running: 'Editing', done: 'Edited' },
  bash: { running: 'Running', done: 'Ran' },
  git: { running: 'Inspecting', done: 'Inspected' },
  glob: { running: 'Finding', done: 'Found' },
  grep: { running: 'Searching', done: 'Searched' },
  delegate: { running: 'Delegating', done: 'Delegated' },
  bash_background: { running: 'Starting', done: 'Started' },
  bash_jobs: { running: 'Checking', done: 'Checked' },
  bash_kill: { running: 'Stopping', done: 'Stopped' },
};

export const toolVerb = (name: string, phase: 'running' | 'done'): string =>
  VERBS[name]?.[phase] ?? (phase === 'running' ? `Calling ${name}` : `Called ${name}`);

// Tool arguments come from the model, so they are cleaned for the terminal and flattened to one
// line before being shown.
export const oneLine = (value: string, max: number): string => {
  const flat = terminalText(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
};

export const toolSubject = (name: string, args: Record<string, unknown>, max = 120): string => {
  const str = (key: string): string | undefined =>
    typeof args[key] === 'string' ? (args[key] as string) : undefined;
  switch (name) {
    case 'bash':
    case 'bash_background':
      return oneLine(str('command') ?? '', max);
    case 'bash_jobs': {
      const id = str('id');
      return id === undefined ? 'jobs' : oneLine(`job ${id}`, max);
    }
    case 'bash_kill':
      return oneLine(`job ${str('id') ?? ''}`, max);
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
    case 'delegate':
      return oneLine(str('title') ?? '', max);
    case 'glob':
    case 'grep': {
      const path = str('path');
      const where = path === undefined || path === '' ? '' : ` in ${path}`;
      return oneLine(`${str('pattern') ?? ''}${where}`, max);
    }
    default:
      return oneLine(str('path') ?? '', max);
  }
};

// Room left for a tool subject on one row, after the glyph, the verb and the duration.
const TOOL_ROW_RESERVED = 30;
export const subjectWidth = (caps: { cols: number }): number =>
  Math.max(10, caps.cols - TOOL_ROW_RESERVED);

// First line of an error result, without the code prefix the model sees.
export const errorSummary = (content: string, max = 160): string => {
  const first = content.split('\n')[0] ?? '';
  return oneLine(first.replace(/^error \[[^\]]+\]: /, ''), max);
};
