import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type EvalRun, snapshot, TASKS } from './tasks.ts';

// Runs the evaluation tasks against a real model and prints one line per task. Each task runs the
// CLI from the sources in a fresh temporary directory; credentials come from the environment.
//
//   bun evals/run.ts --model <family>/<model> [--effort <level>] [--task <name>]... [--keep]

const MAIN = join(import.meta.dir, '../src/main.ts');
const TASK_TIME_LIMIT = '10m';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    effort: { type: 'string' },
    task: { type: 'string', multiple: true },
    keep: { type: 'boolean' },
  },
});
if (values.model === undefined) {
  console.error(
    'usage: bun evals/run.ts --model <family>/<model> [--effort <level>] [--task <name>]... [--keep]',
  );
  process.exit(2);
}
const model = values.model;
const effort = values.effort === undefined ? [] : ['--effort', values.effort];
const selected = TASKS.filter(
  (task) => values.task === undefined || values.task.some((name) => task.name.startsWith(name)),
);

const runTask = async (task: (typeof TASKS)[number]): Promise<EvalRun & { ms: number }> => {
  const dir = mkdtempSync(join(tmpdir(), 'nullrivet-eval-'));
  task.setup(dir);
  const before = snapshot(dir);
  const started = performance.now();
  const child = Bun.spawn(
    [
      MAIN,
      '--json',
      '--model',
      model,
      ...effort,
      '--timeout',
      TASK_TIME_LIMIT,
      ...task.args,
      task.prompt,
    ],
    { cwd: dir, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const events = stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalRun['events'][number]);
  // The final answer is the text after the last tool call; earlier text is narration of the work.
  let answer = '';
  for (const e of events) {
    if (e.type === 'tool:start') answer = '';
    else if (e.type === 'text:delta') answer += String(e.text);
  }
  const run: EvalRun & { ms: number } = {
    dir,
    code,
    events,
    answer,
    steps: events.filter(
      (e) => e.type === 'usage' && e.compaction !== true && e.subagent === undefined,
    ).length,
    compactions: events.filter((e) => e.type === 'context:compact').length,
    tools: events.filter((e) => e.type === 'tool:start').map((e) => String(e.name)),
    changed: snapshot(dir) !== before,
    ms: performance.now() - started,
  };
  return run;
};

const tokensOf = (run: EvalRun): number =>
  run.events
    .filter((e) => e.type === 'usage')
    .reduce(
      (sum, e) =>
        sum + Number(e.input) + Number(e.output) + Number(e.cacheRead) + Number(e.cacheWrite),
      0,
    );

console.log(
  `model ${model}${effort.length > 0 ? ` (effort ${values.effort})` : ''}, ${selected.length} task(s)\n`,
);
let failed = 0;
for (const task of selected) {
  const run = await runTask(task);
  const failures = task.check(run);
  if (failures.length > 0) failed++;
  const stats = [
    `${run.steps} steps`,
    `${Math.round(tokensOf(run) / 1_000)}k tokens`,
    `${run.compactions} compactions`,
    `${Math.round(run.ms / 1_000)}s`,
  ].join(', ');
  console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${task.name}  (${stats})`);
  for (const failure of failures) console.log(`      ${failure}`);
  if (values.keep === true || failures.length > 0) console.log(`      kept in ${run.dir}`);
  else rmSync(run.dir, { recursive: true, force: true });
}
console.log(`\n${selected.length - failed}/${selected.length} passed`);
process.exit(failed === 0 ? 0 : 1);
