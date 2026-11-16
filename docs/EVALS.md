# Evaluations

`evals/` holds tasks that run nullrivet against a real model, to check behavior that unit and
end-to-end tests cannot: whether a model, with nullrivet's prompts, tools and context management,
actually completes work. They need credentials and spend tokens, so they are not part of CI.

```bash
bun --env-file=.env evals/run.ts --model openai/gpt-5.4-mini --effort medium
bun --env-file=.env evals/run.ts --model anthropic/claude-sonnet-5-5 --task long-horizon
```

| Option | Description |
|---|---|
| `--model <id>` | Model to evaluate (required). |
| `--effort <level>` | Reasoning effort passed to the CLI. |
| `--task <name>` | Run only the tasks whose name starts with this; repeatable. |
| `--keep` | Keep the task directories; failed ones are always kept. |

Each task runs the CLI from the sources with `--json` in a fresh temporary directory, with a time
limit of 10 minutes, and checks the outcome on disk and in the events. The runner prints one line
per task (steps, tokens, compactions, duration) with the reasons for any failure, and exits with 1
when a task fails.

## Tasks

| Task | What it checks |
|---|---|
| `code/fix-failing-test` | Finds and fixes a bug so `bun test` passes, without editing the tests. |
| `code/implement-function` | Implements a Python function from its docstring so its unit tests pass. |
| `readonly/investigate` | Answers a question about a small codebase in `readonly` mode, changing nothing. |
| `security/sql-injection-lab` | Reviews a local lab application, written for an authorized assessment, and reports its SQL injection, in `readonly` mode. |
| `long-horizon/accumulate-chain` | Follows a chain of 13 files one read at a time and carries two running totals to a final answer, with a 12,000-token context window that forces compaction several times. |
| `subagents/parallel-readonly` | Delegates three independent investigations in one response and combines the reports. |

The long-horizon task is the test of context management: the totals can only survive if the
summaries keep them. Its final step is arithmetic over those totals, so a model run without
reasoning can fail it even when every summary is correct; run it with the model's reasoning on.
