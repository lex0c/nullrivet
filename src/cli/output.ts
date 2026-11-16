import type { AgentEvent } from '../agent/events.ts';
import { stripAnsi } from '../sanitize/ansi.ts';
import { errorSummary, toolSubject } from '../tui/tool-labels.ts';

export interface OutputSink {
  event(event: AgentEvent): void;
  // Diagnostics produced outside a turn, such as model resolution warnings.
  notice(level: 'warning' | 'error', message: string): void;
  finish(): void;
}

export const NDJSON_VERSION = 1;

// stdout carries only NDJSON so it can be piped into another program; every line is one event.
export const createJsonSink = (write: (line: string) => void): OutputSink => ({
  event(event) {
    write(`${JSON.stringify({ v: NDJSON_VERSION, ...event })}\n`);
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
  const dim = (s: string): string => (options.color ? `\x1b[2m${s}\x1b[22m` : s);
  const red = (s: string): string => (options.color ? `\x1b[31m${s}\x1b[39m` : s);
  const yellow = (s: string): string => (options.color ? `\x1b[33m${s}\x1b[39m` : s);
  let lineOpen = false;
  const titles = new Map<string, string>();
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
          diagnostic(dim(`› ${event.name} ${toolSubject(event.name, event.args)}`));
          return;
        case 'tool:end': {
          const summary = event.meta?.summary;
          const title = titles.get(event.id);
          titles.delete(event.id);
          if (typeof summary === 'string') {
            const label = title === undefined ? '' : `${title}: `;
            diagnostic((event.isError ? red : dim)(`  ${label}${summary}`));
          } else if (event.isError) {
            diagnostic(red(`  ✗ ${errorSummary(event.content, 200)}`));
          }
          return;
        }
        // Subagents run at the same time, so each line names the delegate call's title.
        case 'subagent:start':
          titles.set(event.id, event.title);
          return;
        case 'subagent:progress':
          diagnostic(
            dim(
              `  ↳ ${titles.get(event.id) ?? 'subagent'}: ${event.tool.name} ${toolSubject(event.tool.name, event.tool.args)}`,
            ),
          );
          return;
        // The title stays until the delegate call ends, to label its summary.
        case 'subagent:end':
          return;
        case 'context:compact':
          diagnostic(
            dim(
              `› context compacted (${event.strategy}): ${event.before} → ${event.after} estimated tokens`,
            ),
          );
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
