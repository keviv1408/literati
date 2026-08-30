import {
  applyStep,
  askSucceeds,
  computeState,
  declareIsCorrect,
  teamOf,
  TUTORIAL_VARIANT,
} from '@/lib/tutorial/engine';
import type { Step, TableState } from '@/lib/tutorial/engine';
import { INITIAL_STATE, PLAYERS, SCRIPT } from '@/lib/tutorial/script';
import { getCardHalfSuit, getHalfSuitCards } from '@/types/game';

function allCards(state: TableState): string[] {
  return Object.values(state.hands).flat();
}

function expectConsistentDeal(state: TableState) {
  const cards = allCards(state);
  const declared = new Set(state.declared.map((d) => d.halfSuitId));
  expect(new Set(cards).size).toBe(cards.length);
  expect(cards.length).toBe(48 - 6 * declared.size);
  for (const card of cards) {
    const halfSuit = getCardHalfSuit(card, TUTORIAL_VARIANT);
    expect(halfSuit).not.toBeNull();
    expect(declared.has(halfSuit!)).toBe(false);
  }
}

describe('tutorial script', () => {
  it('deals 48 unique cards, 8 per player', () => {
    expectConsistentDeal(INITIAL_STATE);
    for (const player of PLAYERS) {
      expect(INITIAL_STATE.hands[player.id]).toHaveLength(8);
    }
  });

  it('every ask and declaration is legal at the moment it happens', () => {
    let state = INITIAL_STATE;
    SCRIPT.forEach((step: Step) => {
      switch (step.kind) {
        case 'ask': {
          expect(state.turn).toBe(step.asker);
          expect(teamOf(PLAYERS, step.asker)).not.toBe(teamOf(PLAYERS, step.target));
          expect(state.hands[step.asker]).not.toContain(step.card);
          const halfSuit = getCardHalfSuit(step.card, TUTORIAL_VARIANT)!;
          const holdsOneOfHalfSuit = state.hands[step.asker].some(
            (c) => getCardHalfSuit(c, TUTORIAL_VARIANT) === halfSuit,
          );
          expect(holdsOneOfHalfSuit).toBe(true);
          break;
        }
        case 'declare': {
          expect(state.turn).toBe(step.declarer);
          expect(state.declared.map((d) => d.halfSuitId)).not.toContain(step.halfSuit);
          const cards = getHalfSuitCards(step.halfSuit, TUTORIAL_VARIANT);
          expect(Object.keys(step.assignment).sort()).toEqual([...cards].sort());
          const team = teamOf(PLAYERS, step.declarer);
          for (const holder of Object.values(step.assignment)) {
            expect(teamOf(PLAYERS, holder)).toBe(team);
          }
          break;
        }
        case 'turn':
          expect(PLAYERS.map((p) => p.id)).toContain(step.to);
          break;
        case 'snapshot':
          expectConsistentDeal(step.state);
          break;
        case 'choice':
          expect(step.options.filter((o) => o.correct)).toHaveLength(1);
          break;
        default:
          break;
      }
      state = applyStep(state, step, PLAYERS);
      expectConsistentDeal(state);
    });
  });

  it('tells the intended story', () => {
    const outcomes = SCRIPT.flatMap((step, index) => {
      if (step.kind !== 'declare') return [];
      const before = computeState(INITIAL_STATE, SCRIPT, index - 1, PLAYERS);
      return [[step.declarer, step.halfSuit, declareIsCorrect(before, step)]];
    });
    expect(outcomes).toEqual([
      ['you', 'low_d', true],
      ['raj', 'high_c', true],
      ['omar', 'low_h', false],
    ]);

    const blockIndex = SCRIPT.findIndex(
      (s) => s.kind === 'ask' && s.asker === 'you' && s.card === '9_s',
    );
    const blockStep = SCRIPT[blockIndex] as Extract<Step, { kind: 'ask' }>;
    expect(askSucceeds(computeState(INITIAL_STATE, SCRIPT, blockIndex - 1, PLAYERS), blockStep)).toBe(true);

    const final = computeState(INITIAL_STATE, SCRIPT, SCRIPT.length - 1, PLAYERS);
    expect(final.scores).toEqual({ team1: 3, team2: 2 });
  });
});
