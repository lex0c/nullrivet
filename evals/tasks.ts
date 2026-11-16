import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EvalRun {
  dir: string;
  code: number;
  events: { type: string; [key: string]: unknown }[];
  // Text of the final answer, concatenated from text deltas.
  answer: string;
  // Model requests of the main agent, compaction and subagent requests excluded.
  steps: number;
  compactions: number;
  tools: string[];
  // Whether any file in the task directory was added, removed or changed.
  changed: boolean;
}

export interface EvalTask {
  name: string;
  description: string;
  args: string[];
  prompt: string;
  setup(dir: string): void;
  // Reasons the run failed; empty when it passed.
  check(run: EvalRun): string[];
}

const write = (dir: string, files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    Bun.spawnSync(['mkdir', '-p', join(full, '..')]);
    writeFileSync(full, content);
  }
};

// Paths and content hashes of every file under `dir`, to detect changes.
export const snapshot = (dir: string): string =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((path) => {
      try {
        return `${path}:${Bun.hash(readFileSync(join(dir, path))).toString()}`;
      } catch {
        return path;
      }
    })
    .join('\n');

const expect = (failures: string[], condition: boolean, reason: string): void => {
  if (!condition) failures.push(reason);
};

const ended = (run: EvalRun): string[] => {
  const end = run.events.findLast((e) => e.type === 'agent:end');
  return end?.reason === 'done'
    ? []
    : [`ended with ${String(end?.reason)}: ${String(end?.message)}`];
};

// The chain is walked one file at a time; filler text makes each read large enough that a small
// context window forces compaction, so the running totals must survive summaries.
const CHAIN_VALUES = [9, 4, 7, 2, 8, 5, 3, 6, 1, 9, 7, 18];
const CHAIN_FLAGS = [true, false, true, true, false, false, true, false, true, false, true, false];
const CHAIN_NAMES = [
  'q7x',
  'r1m',
  'k2z',
  'e4p',
  'w9d',
  'u5c',
  'i0t',
  'y3b',
  'o6n',
  'p2h',
  't8v',
  'z9f',
];
const FILLER = `${'This paragraph is filler that only takes up room in the conversation. '.repeat(24)}\n`;

const chainFiles = (): Record<string, string> => {
  const files: Record<string, string> = {
    'start.txt': `This is the start of the chain.\nnext: n_${CHAIN_NAMES[0]}.txt\n`,
  };
  for (const [i, name] of CHAIN_NAMES.entries()) {
    const next = CHAIN_NAMES[i + 1];
    files[`n_${name}.txt`] = [
      `value: ${CHAIN_VALUES[i]}`,
      `flag: ${CHAIN_FLAGS[i] === true ? 'yes' : 'no'}`,
      FILLER,
      `next: ${next === undefined ? 'DONE' : `n_${next}.txt`}`,
      '',
    ].join('\n');
  }
  return files;
};

const CHAIN_ANSWER =
  CHAIN_VALUES.reduce((a, b) => a + b, 0) + CHAIN_FLAGS.filter((flag) => flag).length;

export const TASKS: EvalTask[] = [
  {
    name: 'code/fix-failing-test',
    description: 'Find and fix a bug so an existing test suite passes, without editing the tests.',
    args: [],
    prompt:
      'The tests in this project fail. Find the bug in the code and fix it so `bun test` passes. Do not change the tests.',
    setup(dir) {
      write(dir, {
        'cart.ts': [
          'export interface Item { price: number; quantity: number }',
          '',
          'export const subtotal = (items: Item[]): number =>',
          '  items.reduce((sum, item) => sum + item.price + item.quantity, 0);',
          '',
          'export const total = (items: Item[], discount: number): number =>',
          '  Math.max(0, subtotal(items) - discount);',
          '',
        ].join('\n'),
        'cart.test.ts': [
          "import { expect, test } from 'bun:test';",
          "import { subtotal, total } from './cart.ts';",
          '',
          "test('subtotal multiplies price by quantity', () => {",
          '  expect(subtotal([{ price: 3, quantity: 4 }, { price: 2, quantity: 1 }])).toBe(14);',
          '});',
          '',
          "test('total never goes below zero', () => {",
          '  expect(total([{ price: 1, quantity: 1 }], 5)).toBe(0);',
          '});',
          '',
        ].join('\n'),
      });
    },
    check(run) {
      const failures = ended(run);
      const result = Bun.spawnSync(['bun', 'test'], {
        cwd: run.dir,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect(failures, result.exitCode === 0, 'bun test still fails');
      const tests = readFileSync(join(run.dir, 'cart.test.ts'), 'utf8');
      expect(failures, tests.includes('toBe(14)'), 'the tests were changed');
      return failures;
    },
  },
  {
    name: 'code/implement-function',
    description: 'Implement a function from its docstring so its unit tests pass.',
    args: [],
    prompt:
      'Implement `slugify` in text.py according to its docstring, then run the tests with `python3 -m unittest` and make sure they pass.',
    setup(dir) {
      write(dir, {
        'text.py': [
          'def slugify(title: str) -> str:',
          '    """Lowercase the title, replace every run of characters that are not ASCII letters',
          '    or digits with a single hyphen, and strip hyphens from both ends."""',
          '    raise NotImplementedError',
          '',
        ].join('\n'),
        'test_text.py': [
          'import unittest',
          'from text import slugify',
          '',
          'class SlugifyTest(unittest.TestCase):',
          '    def test_examples(self):',
          '        self.assertEqual(slugify("Hello, World!"), "hello-world")',
          '        self.assertEqual(slugify("  Many   spaces  "), "many-spaces")',
          '        self.assertEqual(slugify("Ünïcode & more"), "n-code-more")',
          '        self.assertEqual(slugify("---"), "")',
          '',
          'if __name__ == "__main__":',
          '    unittest.main()',
          '',
        ].join('\n'),
      });
    },
    check(run) {
      const failures = ended(run);
      const result = Bun.spawnSync(['python3', '-m', 'unittest'], {
        cwd: run.dir,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect(failures, result.exitCode === 0, 'the unit tests fail');
      return failures;
    },
  },
  {
    name: 'readonly/investigate',
    description: 'Answer a question about a small codebase in readonly mode.',
    args: ['--permission', 'readonly'],
    prompt:
      'Which function computes the shipping cost, and how much does it charge for an order of 150? Answer in one sentence.',
    setup(dir) {
      write(dir, {
        'src/orders.ts': [
          "import { shippingFor } from './pricing/shipping.ts';",
          'export const checkout = (amount: number) => amount + shippingFor(amount);',
          '',
        ].join('\n'),
        'src/pricing/shipping.ts': [
          'const FREE_ABOVE = 200;',
          'export const shippingFor = (amount: number): number =>',
          '  amount > FREE_ABOVE ? 0 : amount > 100 ? 7.5 : 12;',
          '',
        ].join('\n'),
        'src/pricing/tax.ts': 'export const taxFor = (amount: number): number => amount * 0.2;\n',
      });
    },
    check(run) {
      const failures = ended(run);
      expect(failures, run.answer.includes('shippingFor'), 'the answer does not name shippingFor');
      expect(failures, /7\.5|7\.50/.test(run.answer), 'the answer does not give 7.5');
      expect(failures, !run.changed, 'files were changed in readonly mode');
      return failures;
    },
  },
  {
    name: 'security/sql-injection-lab',
    description:
      'Authorized review of a local lab application: find an SQL injection without changing files.',
    args: ['--permission', 'readonly'],
    prompt:
      'This directory holds a small lab application written for an authorized security assessment. Review app.py and report the vulnerable function, the vulnerability class, the line, and how to fix it. Do not modify files.',
    setup(dir) {
      write(dir, {
        'app.py': [
          'import sqlite3',
          '',
          'def find_user(conn: sqlite3.Connection, name: str):',
          '    return conn.execute("SELECT id, name FROM users WHERE name = ?", (name,)).fetchone()',
          '',
          'def login(conn: sqlite3.Connection, name: str, password: str) -> bool:',
          `    query = f"SELECT id FROM users WHERE name = '{name}' AND password = '{password}'"`,
          '    return conn.execute(query).fetchone() is not None',
          '',
        ].join('\n'),
      });
    },
    check(run) {
      const failures = ended(run);
      expect(failures, /sql injection/i.test(run.answer), 'the answer does not name SQL injection');
      expect(failures, run.answer.includes('login'), 'the answer does not name login');
      expect(failures, !run.changed, 'files were changed in readonly mode');
      return failures;
    },
  },
  {
    name: 'long-horizon/accumulate-chain',
    description:
      'Follow a chain of files one read at a time, carrying two running totals through compactions.',
    args: ['--context-window', '12000'],
    prompt: [
      'You are given a linked chain of files in the current directory. Begin by reading `start.txt`.',
      'Every file has a `next:` line naming the next file to read: read that file next with read_file, and keep following the `next:` pointers until you reach a file whose line is `next: DONE`.',
      'Discover each file ONLY by following the `next:` pointer of the file you just read. Do NOT list the directory, do NOT use glob or grep, and do NOT guess filenames.',
      'As you go, track two running quantities across the whole chain: the sum of every `value:` number, and the count of files whose line is `flag: yes`.',
      'When you reach `next: DONE`, compute `final = sum + count` and write ONLY that number (digits only) to a new file named `result.txt`.',
    ].join('\n'),
    setup(dir) {
      write(dir, chainFiles());
    },
    check(run) {
      const failures = ended(run);
      let result = '';
      try {
        result = readFileSync(join(run.dir, 'result.txt'), 'utf8').trim();
      } catch {
        failures.push('result.txt was not written');
      }
      expect(
        failures,
        result === String(CHAIN_ANSWER),
        `result.txt is "${result}", expected ${CHAIN_ANSWER}`,
      );
      expect(
        failures,
        run.steps >= CHAIN_NAMES.length,
        `only ${run.steps} steps: the chain was not walked`,
      );
      expect(failures, run.compactions >= 1, 'no compaction happened, so the task did not test it');
      return failures;
    },
  },
  {
    name: 'subagents/parallel-readonly',
    description: 'Delegate independent investigations to subagents and combine their reports.',
    args: ['--permission', 'readonly'],
    prompt:
      'Each of the directories svc-a, svc-b and svc-c holds a service. Delegate one investigation per service, in a single response so they run in parallel, to find the TCP port the service listens on. Then answer with the three ports.',
    setup(dir) {
      write(dir, {
        'svc-a/config/server.toml': '[server]\nport = 7311\n',
        'svc-b/src/main.py': 'import os\nPORT = int(os.environ.get("PORT", "7322"))\n',
        'svc-c/run.sh': '#!/bin/sh\nexec ./server --listen 0.0.0.0:7333\n',
      });
    },
    check(run) {
      const failures = ended(run);
      const delegated = run.tools.filter((tool) => tool === 'delegate').length;
      expect(failures, delegated >= 2, `delegate was called ${delegated} times`);
      for (const port of ['7311', '7322', '7333']) {
        expect(failures, run.answer.includes(port), `the answer lacks port ${port}`);
      }
      return failures;
    },
  },
];
