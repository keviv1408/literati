import { BACK_WITHIN_MS, DEADLINE_MARGIN_MS, FREEZE_AGE_MS, REFUSE_MS } from './limits';
import type { Kill } from './plan';

// The top of the kind's down range, not this kill's downMs: the rule bounds the longest a kill of the kind can last.
export function worstCaseMs(kill: Kill): number {
  return {
    cut: BACK_WITHIN_MS.cut,
    freeze: FREEZE_AGE_MS[1] + BACK_WITHIN_MS.freeze,
    refuse: REFUSE_MS[1] + BACK_WITHIN_MS.refuse,
    restart: 0,
  }[kill.kind];
}

export function mayTakeHolderDown(kill: Kill, deadlineAt: number | null, now: number): boolean {
  // A restart clears both server clocks, and the restored game starts a fresh turn timer.
  if (kill.kind === 'restart' || deadlineAt === null) return true;
  return now + worstCaseMs(kill) + DEADLINE_MARGIN_MS <= deadlineAt;
}

export function mayWaitForSeats(
  inProgress: { kill: Kill; startedAt: number }[],
  deadlineAt: number | null,
  choiceOpen: boolean,
  _now: number,
): boolean {
  if (choiceOpen) return false;
  // The holder test, timed from each kill's start: its seat is back by then plus its worst case.
  return inProgress.every(({ kill, startedAt }) => mayTakeHolderDown(kill, deadlineAt, startedAt));
}
