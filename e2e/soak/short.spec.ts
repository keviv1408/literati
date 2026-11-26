import { expect, test } from '@playwright/test';
import { playGame, type GameResult } from './lib/driver';
import { SHORT_SEED } from './lib/limits';
import { KILL_KINDS } from './lib/plan';
import { writeReport } from './lib/report';
import { startStack } from './lib/stack';

test('short soak: one game, four kills', async ({ browser }) => {
  const outDir = test.info().outputDir;
  const started = Date.now();
  const results: GameResult[] = [];
  try {
    const stack = await startStack('standin', outDir);
    results.push(await playGame({ browser, stack, seed: SHORT_SEED, size: 'short', outDir }).finally(() => stack.stop()));
  } finally {
    writeReport(outDir, results, 1, Date.now() - started);
  }
  const [result] = results;
  expect(result.kills).toHaveLength(4);
  expect(result.kills.map((record) => record.kill.kind).sort()).toEqual([...KILL_KINDS].sort());
});
