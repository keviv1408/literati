export const BACKEND_URL = 'http://localhost:3012';
export const FRONTEND_URL = 'http://localhost:3011';
export const STANDIN_URL = 'http://127.0.0.1:54321';

export const READY_TIMEOUT_MS = 30_000;

export const SHORT_SEED = 20261126;
export const LONG_GAMES = 5;

export const PACE_MS = [300, 1500] as const;
export const MISS_RATE = 0.3;
export const MISS_BUDGET = 12;

export const KILL_COUNT = { short: 4, long: 8 };
// Kills are due before moves 2 to this: the first move settles before any kill.
export const DUE_WINDOW = { short: 12, long: 30 };
// Between the page's 20 s reconnect-on-visible and its 35 s dead-socket clocks.
export const FREEZE_AGE_MS = [21_000, 30_000] as const;
export const FREEZE_FRESH_MS = 2_000;
export const REFUSE_MS = [5_000, 20_000] as const;
export const RESTART_WAIT_MS = [2_000, 15_000] as const;
export const BACK_WITHIN_MS = { cut: 5_000, freeze: 3_000, refuse: 12_000, restart: 20_000 };
export const DEADLINE_MARGIN_MS = 10_000;
export const MAX_SEATS_DOWN = 2;
export const MOVES_WHILE_DOWN = [1, 4] as const;

// Under the server's 60 s turn timer.
export const STEP_WAIT_MS = 50_000;
export const GAME_CAP_MS = { short: 360_000, long: 600_000 };
export const LOST_MOVES_MAX = 2;
export const AFTER_MOVE_POLL_MS = 5_000;

export const LOBBY_WAIT_MS = 30_000;
export const FIRST_SAVE_MS = 10_000;
// game_over goes out before the final save, so the game summary trails it.
export const FINAL_SAVE_MS = 10_000;
export const LOG_TAIL_LINES = 20;
// Ten chained 100 ms timers: about 1 s on a live page, 5 s or more on a throttled background one.
export const TIMER_CHAIN_MAX_MS = 1_500;
