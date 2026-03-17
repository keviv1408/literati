'use client';

/**
 * GameContext — provides live game state to all in-game components.
 *
 * Acts as the "game store" for the active game view.  The game page
 * instantiates `useGameSocket`, wraps the return value in the shape
 * expected by `GameContextValue`, and passes it to `<GameProvider>`.
 * Any descendant can then call `useGameContext()` to access the live
 * player roster, hand, game state, and send helpers.
 *
 * Design notes:
 *  • We keep the context value interface purposely thin — only what
 *    sub-components need; no internal WebSocket logic lives here.
 *  • `getPlayerBySeat` is a convenience selector so consumers can
 *    look up a `GamePlayer` by seat index without importing filtering
 *    logic everywhere.
 *  • Calling `useGameContext()` outside a `<GameProvider>` throws a
 *    clear error to catch missing wiring early.
 *
 * @example
 * // Game page wires the context:
 * const socket = useGameSocket({ roomCode, bearerToken });
 * return (
 *   <GameProvider value={socket}>
 *     <OvalGameTable />
 *   </GameProvider>
 * );
 *
 * @example
 * // Child component reads live state:
 * const { players, myPlayerId, gameState } = useGameContext();
 */

import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type {
  CardId,
  GamePlayer,
  HalfSuitId,
  PublicGameState,
  AskResultPayload,
  DeclarationResultPayload,
  DeclareProgressPayload,
  RematchVoteUpdatePayload,
  RematchDeclinedPayload,
  BotTakeoverPayload,
} from '@/types/game';
import type { GameWsStatus, TurnTimerPayload, PartialSelectionPayload } from '@/hooks/useGameSocket';

// ── Context value shape ────────────────────────────────────────────────────────

export interface GameContextValue {
  /** Current WebSocket connection status. */
  wsStatus: GameWsStatus;

  /** This client's own player ID (null until game_init is received). */
  myPlayerId: string | null;

  /** Cards in this player's hand (empty for spectators). */
  myHand: CardId[];

  /** All players in the game, ordered by seatIndex. */
  players: GamePlayer[];

  /** Public game state (scores, turn, declared suits, etc.). */
  gameState: PublicGameState | null;

  /** Card removal variant for the current game. */
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;

  /** Total player count (6 or 8). */
  playerCount: 6 | 8 | null;

  /** Active turn timer payload (null when no timer is running). */
  turnTimer: TurnTimerPayload | null;

  /** Most recent ask result (null until first ask). */
  lastAskResult: AskResultPayload | null;

  /** Most recent declaration result (null until first declaration). */
  lastDeclareResult: DeclarationResultPayload | null;

  /**
   * Sub-AC 28a: IDs of all non-eliminated players with at least one card
   * remaining, as reported by the server in the most recent `declaration_result`
   * message.  Empty array until the first declaration.
   *
   * Components can use this to:
   *   • Dim eliminated-player seats immediately after a declaration.
   *   • Power a "who can receive the next turn?" indicator on the table.
   *   • Drive any animation that highlights still-active participants.
   */
  eligibleNextTurnPlayerIds: string[];

  /**
   * Live declaration progress from another player's in-progress DeclareModal.
   * Non-null while the declarant is assigning cards (Step 2).
   * Cleared when declaration_result arrives or declarant cancels.
   * Use this to render a "X is declaring Low Spades (3/6)" banner.
   */
  declareProgress?: DeclareProgressPayload | null;

  /**
   * Stream declaration card-assignment progress to the server so all other
   * clients see a live banner.  Call on every assignment change in Step 2.
   * Pass `halfSuitId: null` when the player cancels.
   */
  sendDeclareProgress?: (halfSuitId: HalfSuitId | null, assignment: Record<CardId, string>) => void;

  /** WebSocket error message, if any. */
  error: string | null;

  /** Current rematch vote tally (null until game ends or no active vote). */
  rematchVote?: RematchVoteUpdatePayload | null;

  /** Non-null once the rematch vote closed without a majority yes. */
  rematchDeclined?: RematchDeclinedPayload | null;

  /** Send a rematch vote to the server (true = yes, false = no). */
  sendRematchVote?: (vote: boolean) => void;

  /**
   * Non-null when the server broadcasted a bot_takeover event for the current
   * room (i.e. a human player's turn timer expired).  Cleared automatically
   * when the following ask_result or declaration_result arrives.
   */
  botTakeover?: BotTakeoverPayload | null;

  /**
   * Report the current wizard step to the server (fire-and-forget).
   * Called by CardRequestWizard / DeclareModal after each step transition
   * so the server can deterministically complete the action if the timer fires.
   */
  sendPartialSelection?: (partial: PartialSelectionPayload) => void;

  /**
   * Look up the player occupying a given seat index.
   * Returns `null` if the seat is empty or not yet populated.
   */
  getPlayerBySeat: (seatIndex: number) => GamePlayer | null;

  /** Send an ask-card action to the server. */
  sendAsk: (targetPlayerId: string, cardId: CardId) => void;

  /** Send a declare-suit action to the server. */
  sendDeclare: (halfSuitId: HalfSuitId, assignment: Record<CardId, string>) => void;
}

// ── Context ────────────────────────────────────────────────────────────────────

const GameContext = createContext<GameContextValue | null>(null);
GameContext.displayName = 'GameContext';

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Access the live game state from within a `<GameProvider>` subtree.
 *
 * @throws {Error} If called outside a `<GameProvider>`.
 */
export function useGameContext(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) {
    throw new Error(
      '[GameContext] useGameContext() must be used inside a <GameProvider>. ' +
      'Ensure the game page wraps its subtree with <GameProvider value={...}>.',
    );
  }
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface GameProviderProps {
  /**
   * Game state value — typically the return value of `useGameSocket()`
   * supplemented with the `getPlayerBySeat` selector.
   */
  value: Omit<GameContextValue, 'getPlayerBySeat'> & {
    getPlayerBySeat?: (seatIndex: number) => GamePlayer | null;
  };

  children: ReactNode;
}

/**
 * `GameProvider` makes live game state available to all descendant components.
 *
 * Pass in the `useGameSocket` return value (plus any extras) as `value`.
 * The provider attaches a `getPlayerBySeat` convenience selector if one is
 * not already present in the value object.
 */
export function GameProvider({ value, children }: GameProviderProps) {
  // Build the convenience selector once per players array change.
  const getPlayerBySeat = useMemo<(seatIndex: number) => GamePlayer | null>(() => {
    if (value.getPlayerBySeat) return value.getPlayerBySeat;
    return (seatIndex: number) =>
      value.players.find((p) => p.seatIndex === seatIndex) ?? null;
  }, [value]);

  const contextValue = useMemo<GameContextValue>(
    () => ({ ...value, getPlayerBySeat }),
    [value, getPlayerBySeat],
  );

  return (
    <GameContext.Provider value={contextValue}>
      {children}
    </GameContext.Provider>
  );
}
