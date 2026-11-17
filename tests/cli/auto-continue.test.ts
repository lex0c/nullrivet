import { describe, expect, test } from 'bun:test';
import { createAutoContinue } from '../../src/cli/auto-continue.ts';

const DELAY_MS = 5;

// A session whose state the test sets. By default it is idle, events are pending, and a started
// turn holds the session, as the REPL's reservation of `turn` does, until the test frees it.
const session = (maxTurns = 3) => {
  const s = { idle: true, events: true, accepts: true, started: 0, notices: [] as string[] };
  const auto = createAutoContinue({
    isIdle: () => s.idle,
    hasEvents: () => s.events,
    start: () => {
      if (!s.accepts) return false;
      s.started += 1;
      s.idle = false;
      return true;
    },
    notice: (text) => s.notices.push(text),
    delayMs: DELAY_MS,
    maxTurns,
  });
  return { s, auto };
};

const settle = (): Promise<void> => Bun.sleep(DELAY_MS * 6);

// Ends the running automatic turn with `done` and lets the session check again.
const finishTurn = async (h: ReturnType<typeof session>): Promise<void> => {
  h.auto.turnEnded('done');
  h.s.idle = true;
  h.auto.poke();
  await settle();
};

describe('automatic continuation', () => {
  test('pokes close together start one turn, and a running turn blocks another', async () => {
    const h = session();
    h.auto.poke();
    h.auto.poke();
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(1);
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(1);
  });

  test('the check runs once the pokes stop, not at a fixed time after the first', async () => {
    let started = 0;
    const auto = createAutoContinue({
      isIdle: () => true,
      hasEvents: () => true,
      start: () => {
        started += 1;
        return true;
      },
      notice: () => undefined,
      delayMs: 100,
    });
    auto.poke();
    await Bun.sleep(70);
    auto.poke();
    await Bun.sleep(70);
    expect(started).toBe(0);
    await Bun.sleep(100);
    expect(started).toBe(1);
    auto.dispose();
  });

  test('a busy session starts nothing until it is idle and poked again', async () => {
    const h = session();
    h.s.idle = false;
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(0);
    h.s.idle = true;
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(1);
  });

  test('nothing starts without pending events', async () => {
    const h = session();
    h.s.events = false;
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(0);
  });

  test('a start that does not happen is not counted', async () => {
    const h = session(2);
    h.s.accepts = false;
    for (let i = 0; i < 3; i++) {
      h.auto.poke();
      await settle();
    }
    h.s.accepts = true;
    h.auto.poke();
    await settle();
    await finishTurn(h);
    expect(h.s.started).toBe(2);
    expect(h.s.notices).toEqual([]);
  });

  test('stops at the limit with one notice, until a prompt renews it', async () => {
    const h = session(3);
    h.auto.poke();
    await settle();
    await finishTurn(h);
    await finishTurn(h);
    await finishTurn(h);
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(3);
    expect(h.s.notices).toEqual([
      'Automatic continuation paused after 3 turns without a prompt; send a prompt to continue.',
    ]);
    h.auto.userPrompted();
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(4);
  });

  test('a pause holds pending events until the next prompt', async () => {
    const h = session();
    h.auto.pause();
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(0);
    h.auto.userPrompted();
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(1);
  });

  test('a turn that does not end with done suspends, and one that does not', async () => {
    for (const reason of ['aborted', 'error', 'budget'] as const) {
      const h = session();
      h.auto.turnEnded(reason);
      h.auto.poke();
      await settle();
      expect(h.s.started).toBe(0);
    }
    const h = session();
    h.auto.turnEnded('done');
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(1);
  });

  test('dispose cancels a scheduled check', async () => {
    const h = session();
    h.auto.poke();
    h.auto.dispose();
    await settle();
    h.auto.poke();
    await settle();
    expect(h.s.started).toBe(0);
  });
});
