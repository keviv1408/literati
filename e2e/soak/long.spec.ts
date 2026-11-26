import path from 'node:path';
import { test } from '@playwright/test';
import { playGame, type GameResult } from './lib/driver';
import { LONG_GAMES } from './lib/limits';
import { writeReport } from './lib/report';
import { startStack } from './lib/stack';

test('long soak', async ({ browser }) => {
  const fixedSeed = _fixedSeed(process.env.SOAK_SEED);
  const games = fixedSeed === null ? LONG_GAMES : 1;
  const outDir = test.info().outputDir;
  const started = Date.now();
  const results: GameResult[] = [];
  try {
    for (let n = 1; n <= games; n++) {
      const seed = fixedSeed ?? Date.now();
      console.log(`game ${n} of ${games}, seed ${seed}`);
      // A stack per game, so each game's folder holds its own backend log.
      const gameDir = path.join(outDir, `game-${n}`);
      const stack = await startStack('real', gameDir);
      results.push(await playGame({ browser, stack, seed, size: 'long', outDir: gameDir }).finally(() => stack.stop()));
    }
  } finally {
    writeReport(outDir, results, games, Date.now() - started);
  }
});

function _fixedSeed(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seed = Number(value);
  // Number() alone would take '', ' 7', '1e3' and '0x10'.
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seed)) {
    throw new Error(`SOAK_SEED must be a whole number, got "${value}"`);
  }
  return seed;
}
