import type { AgentEvent } from '../agent/events.ts';
import { stripAnsi } from '../sanitize/ansi.ts';
import { readFileDiff } from '../tools/line-diff.ts';
import { errorSummary, toolSubject } from '../tui/tool-labels.ts';

export interface OutputSink {
  event(event: AgentEvent): void;
  // Diagnostics produced outside a turn, such as model resolution warnings.
  notice(level: 'warning' | 'error', message: string): void;
  finish(): void;
}

export const NDJSON_VERSION = 1;

// stdout carries only NDJSON so it can be piped into another program; every line is one event.
// The diff of an edit or write holds lines of the file, among them lines the model never read,
// such as the content a write replaced. NDJSON often ends up in build logs, so it carries only
// the counts.
const withoutDiffLines = (event: AgentEvent): AgentEvent => {
  if (event.type !== 'tool:end' || event.meta?.diff === undefined) return event;
  const { diff: _, ...meta } = event.meta;
  const diff = readFileDiff(event.meta);
  return {
    ...event,
    meta: diff === null ? meta : { ...meta, diff: { added: diff.added, removed: diff.removed } },
  };
};

export const createJsonSink = (write: (line: string) => void): OutputSink => ({
  event(event) {
    write(`${JSON.stringify({ v: NDJSON_VERSION, ...withoutDiffLines(event) })}\n`);
  },
  notice(level, message) {
    write(`${JSON.stringify({ v: NDJSON_VERSION, type: level, message })}\n`);
  },
  finish() {},
});

export interface PlainSinkOptions {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

// The answer goes to stdout and everything else (tool activity, warnings, errors) to stderr, so
// `nullrivet "..." > answer.md` captures only the answer.
export const createPlainSink = (options: PlainSinkOptions): OutputSink => {
  // Grey rather than faint, which many xterm configurations draw as plain text.
  const grey = (s: string): string => (options.color ? `\x1b[90m${s}\x1b[39m` : s);
  const red = (s: string): string => (options.color ? `\x1b[31m${s}\x1b[39m` : s);
  const green = (s: string): string => (options.color ? `\x1b[32m${s}\x1b[39m` : s);
  const yellow = (s: string): string => (options.color ? `\x1b[33m${s}\x1b[39m` : s);
  let lineOpen = false;
  const closeLine = (): void => {
    if (lineOpen) {
      options.stdout('\n');
      lineOpen = false;
    }
  };
  const diagnostic = (text: string): void => {
    closeLine();
    options.stderr(`${text}\n`);
  };

  return {
    event(event) {
      switch (event.type) {
        case 'text:delta': {
          const text = stripAnsi(event.text);
          if (text.length === 0) return;
          options.stdout(text);
          lineOpen = !text.endsWith('\n');
          return;
        }
        case 'tool:start':
          diagnostic(grey(`› ${event.name} ${toolSubject(event.name, event.args)}`));
          return;
        case 'tool:end': {
          if (event.isError) {
            diagnostic(red(`  ✗ ${errorSummary(event.content, 200)}`));
            return;
          }
          const diff = readFileDiff(event.meta);
          if (diff !== null && diff.added + diff.removed > 0) {
            diagnostic(`  ${green(`+${diff.added}`)} ${red(`-${diff.removed}`)}`);
          }
          return;
        }
        case 'context:compact':
          diagnostic(
            grey(
              `› context compacted (${event.strategy}): ${event.before} → ${event.after} estimated tokens`,
            ),
          );
          return;
        case 'notice':
          diagnostic(grey(`› note: ${stripAnsi(event.text)}`));
          return;
        case 'warning':
          diagnostic(yellow(`warning: ${event.message}`));
          return;
        case 'error':
          diagnostic(red(`error: ${event.message}`));
          return;
        case 'agent:end':
          if (event.reason === 'budget' && event.message !== undefined) {
            diagnostic(yellow(`stopped: ${event.message}`));
          } else if (event.reason === 'aborted') {
            diagnostic(yellow('aborted'));
          }
          return;
        default:
          return;
      }
    },
    notice(level, message) {
      diagnostic(level === 'error' ? red(`error: ${message}`) : yellow(`warning: ${message}`));
    },
    finish() {
      closeLine();
    },
  };
};
