/**
 * Tutorial engine: a scripted Literature hand replayed as a pure reducer.
 * The UI only stores the step index; the table state at any step is
 * `computeState(script, index)`, which makes Back/Next trivial.
 */

import { getHalfSuitCards, parseCard } from '@/types/game';
import type { CardId, DeclaredSuit, HalfSuitId } from '@/types/game';

export const TUTORIAL_VARIANT = 'remove_7s' as const;

export interface TutorialPlayer {
  id: string;
  name: string;
  teamId: 1 | 2;
}

export interface Scores {
  team1: number;
  team2: number;
}

export interface TableState {
  hands: Record<string, CardId[]>;
  turn: string;
  scores: Scores;
  declared: DeclaredSuit[];
}

export interface ChoiceOption {
  label: string;
  correct?: boolean;
  feedback: string;
}

export type Step =
  | { kind: 'intro'; title: string; body: string[]; showHalfSuits?: boolean; final?: boolean }
  | { kind: 'note'; text: string; focus?: string[]; cards?: CardId[] }
  | { kind: 'ask'; asker: string; target: string; card: CardId; text: string }
  | {
      kind: 'declare';
      declarer: string;
      halfSuit: HalfSuitId;
      assignment: Record<CardId, string>;
      text: string;
    }
  | { kind: 'turn'; to: string; text: string }
  | { kind: 'choice'; prompt: string; options: ChoiceOption[]; focus?: string[]; cards?: CardId[] }
  | { kind: 'snapshot'; state: TableState; text: string };

const SUIT_ORDER: Record<string, number> = { s: 0, h: 1, d: 2, c: 3 };

export function sortHand(hand: CardId[]): CardId[] {
  return [...hand].sort((a, b) => {
    const pa = parseCard(a);
    const pb = parseCard(b);
    return SUIT_ORDER[pa.suit] - SUIT_ORDER[pb.suit] || pa.rank - pb.rank;
  });
}

export function teamOf(players: TutorialPlayer[], playerId: string): 1 | 2 {
  const player = players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown tutorial player: ${playerId}`);
  return player.teamId;
}

export function askSucceeds(state: TableState, step: Extract<Step, { kind: 'ask' }>): boolean {
  return state.hands[step.target].includes(step.card);
}

export function declareIsCorrect(
  state: TableState,
  step: Extract<Step, { kind: 'declare' }>,
): boolean {
  return getHalfSuitCards(step.halfSuit, TUTORIAL_VARIANT).every((card) =>
    state.hands[step.assignment[card]]?.includes(card),
  );
}

export function applyStep(state: TableState, step: Step, players: TutorialPlayer[]): TableState {
  switch (step.kind) {
    case 'ask': {
      if (!askSucceeds(state, step)) return { ...state, turn: step.target };
      return {
        ...state,
        hands: {
          ...state.hands,
          [step.target]: state.hands[step.target].filter((c) => c !== step.card),
          [step.asker]: [...state.hands[step.asker], step.card],
        },
      };
    }
    case 'declare': {
      const cards = new Set(getHalfSuitCards(step.halfSuit, TUTORIAL_VARIANT));
      const declarerTeam = teamOf(players, step.declarer);
      const correct = declareIsCorrect(state, step);
      const winner: 1 | 2 = correct ? declarerTeam : declarerTeam === 1 ? 2 : 1;
      const hands: Record<string, CardId[]> = {};
      for (const [pid, hand] of Object.entries(state.hands)) {
        hands[pid] = hand.filter((c) => !cards.has(c));
      }
      return {
        ...state,
        hands,
        scores: {
          team1: state.scores.team1 + (winner === 1 ? 1 : 0),
          team2: state.scores.team2 + (winner === 2 ? 1 : 0),
        },
        declared: [
          ...state.declared,
          { halfSuitId: step.halfSuit, teamId: winner, declaredBy: step.declarer },
        ],
      };
    }
    case 'turn':
      return { ...state, turn: step.to };
    case 'snapshot':
      return step.state;
    default:
      return state;
  }
}

export function computeState(
  initial: TableState,
  script: Step[],
  upTo: number,
  players: TutorialPlayer[],
): TableState {
  let state = initial;
  for (let i = 0; i <= upTo && i < script.length; i++) {
    state = applyStep(state, script[i], players);
  }
  return state;
}

/** State just before `index` was applied; used to describe what an ask/declare did. */
export function stateBefore(
  initial: TableState,
  script: Step[],
  index: number,
  players: TutorialPlayer[],
): TableState {
  return computeState(initial, script, index - 1, players);
}
