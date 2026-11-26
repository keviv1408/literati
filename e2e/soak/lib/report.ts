import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GameResult } from './driver';
import type { Model } from './model';
import { KILL_KINDS, type Kill } from './plan';
import type { Seat } from './seats';

export interface Run {
  log(line: string): void;
  frames(seat: Pick<Seat, 'index' | 'wire'>): void;
  model(model: Model): void;
  close(result: GameResult | Error): void;
}

// No server frame carries a credential today; this keeps one out of the files if that ever changes.
const _SECRET_KEY = /token|recoverykey/i;

export function openRun(outDir: string, seed: number, plan: Kill[]): Run {
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const logFile = path.join(outDir, 'run.log');
  writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify({ seed, plan }, null, 2)}\n`);
  writeFileSync(logFile, '');
  const log = (line: string) => appendFileSync(logFile, `${_elapsed(started)} ${line}\n`);

  const header = [`soak seed ${seed}, ${plan.length} kill(s) planned`, ...plan.map(_killLine)];
  console.log(header.join('\n'));
  header.forEach(log);

  return {
    log,
    frames(seat) {
      const lines = seat.wire.sockets.flatMap((socket) => {
        const end = socket.cut ? { cut: true } : socket.closed ? { closed: socket.closed } : null;
        return [
          { socket: socket.index, at: socket.openedAt, opened: true },
          ...socket.frames.map(({ at, msg }) => ({ socket: socket.index, at, msg })),
          ...(end ? [{ socket: socket.index, ...end }] : []),
        ].map((line) => JSON.stringify(line, _redact));
      });
      writeFileSync(path.join(outDir, `frames-seat${seat.index}.jsonl`), `${lines.join('\n')}\n`);
    },
    model(model) {
      const snapshot = {
        turn: model.turn,
        asks: model.asks,
        declarations: model.declarations,
        scores: model.scores,
        teams: Object.fromEntries(model.teams),
        declared: Object.fromEntries(model.declared),
        hands: Object.fromEntries([...model.hands].map(([playerId, hand]) => [playerId, [...hand].sort()])),
        history: model.history,
      };
      writeFileSync(path.join(outDir, 'model.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    },
    close(result) {
      if (result instanceof Error) {
        log(`failed: ${result.message}`);
        return;
      }
      const { moves, scores, kills } = result;
      const line = `game over: ${moves} moves, team1 ${scores.team1} team2 ${scores.team2}, ${kills.length} kill(s), ${_elapsed(started)}`;
      log(line);
      console.log(line);
    },
  };
}

export function writeReport(outDir: string, results: GameResult[], planned: number, totalMs: number): void {
  // Playwright makes the test's folder lazily, and a stack that refused to start never made it.
  mkdirSync(outDir, { recursive: true });
  const head = ['game', 'seed', 'moves', ...KILL_KINDS, 'lost'];
  const rows = results.map((result, i) => [
    String(i + 1),
    String(result.seed),
    String(result.moves),
    ...KILL_KINDS.map((kind) => (result.kills.some((record) => record.kill.kind === kind) ? String(result.worstBackMs[kind]) : '-')),
    result.lostMoves.join(' ') || '-',
  ]);
  const table = [head, ...rows];
  const widths = head.map((_, col) => Math.max(...table.map((row) => row[col].length)));
  const lines = [
    `${results.length} of ${planned} game(s) finished in ${(totalMs / 60_000).toFixed(1)} min`,
    'kinds: worst time back in ms; lost: moves lost per restart',
    ...table.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()),
  ];
  const text = `${lines.join('\n')}\n`;
  writeFileSync(path.join(outDir, 'report.txt'), text);
  console.log(text);
}

function _killLine(kill: Kill): string {
  const seat = kill.seat === 'mover' ? 'the mover' : `seat ${kill.seat}`;
  return `#${kill.id} ${kill.kind} ${seat} ${kill.timing}, due before move ${kill.dueBeforeMove}, down ${kill.downMs} ms, ${kill.movesWhileDown} move(s) while down`;
}

function _elapsed(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)} s`;
}

function _redact(key: string, value: unknown): unknown {
  return _SECRET_KEY.test(key) ? '[redacted]' : value;
}
