'use client';

/**
 * GamePlayerSeat — compact seat chip for the active game view.
 *
 * Renders one player's position around the oval game table during an active
 * game.  It is the game-play counterpart to the lobby's `PlayerSeat` component
 * and works with the richer `GamePlayer` type (which carries live game
 * attributes such as `cardCount`, `isCurrentTurn`, and `teamId`).
 *
 * ### Two render states
 * | State    | Trigger              | Visual                              |
 * |----------|----------------------|-------------------------------------|
 * | Occupied | `player` is not null | Avatar + name + badges + card count |
 * | Empty    | `player` is null     | Pulsing hourglass + "Waiting…"      |
 *
 * ### What is displayed (occupied)
 * - **Avatar**: image from `player.avatarId` (treated as a URL); falls back to
 *   an initials circle deterministically coloured by display name.
 * - **Name**: plain text for humans; `<BotBadge>` widget for bots.
 * - **"You" pill**: appears when `player.playerId === myPlayerId`.
 * - **Active-turn glow**: outer container receives `animate-seat-glow`
 *   (amber box-shadow keyframe from `globals.css`) + an inset amber ring
 *   when it is this player's turn.  Both effects are removed the moment
 *   `currentTurnPlayerId` (or `isActiveTurn`) no longer matches, i.e.
 *   as soon as the player takes an action and the server advances the turn.
 * - **Card count badge**: small circle showing remaining hand size.
 * - **Team colour**: border and background tinted emerald (T1) or violet (T2).
 * - **Inference indicator**: shown when inference mode is active and data exists.
 *
 * ### Active-turn animation lifecycle
 * The animation is triggered by either:
 *  1. The `isActiveTurn` boolean prop (explicit override), or
 *  2. `currentTurnPlayerId === player.playerId` / `player.isCurrentTurn` (derived).
 *
 * It is automatically cleared when the player submits an ask or declaration:
 * the server advances `currentTurnPlayerId`, the prop updates, and React
 * removes the CSS classes on the next render.
 *
 * ### Inference mode integration
 * When `inference` prop is provided (a `PlayerInference` map from
 * `useCardInference`), an `<InferenceIndicator>` badge is rendered showing
 * confirmed and excluded card counts.  The parent is responsible for gating
 * this prop based on whether inference mode is active.  Spectators always
 * have it active (forced by `InferenceProvider`).
 *
 * ### Wired to the game store
 * Although this component is pure (all data via props), it is designed to be
 * driven directly from the `useGameContext()` hook's live `players` array.
 * See `GameContext.tsx` for the provider setup.
 *
 * @example
 * // Inside a game table component:
 * const { players, myPlayerId, gameState } = useGameContext();
 * const player = players.find(p => p.seatIndex === seatIndex) ?? null;
 * <GamePlayerSeat
 *   seatIndex={seatIndex}
 *   player={player}
 *   myPlayerId={myPlayerId}
 *   currentTurnPlayerId={gameState?.currentTurnPlayerId ?? null}
 * />
 */

import React from 'react';
import Avatar from '@/components/Avatar';
import { BotBadge } from '@/components/BotBadge';
import InferenceIndicator from '@/components/InferenceIndicator';
import type { GamePlayer } from '@/types/game';
import type { PlayerInference } from '@/hooks/useCardInference';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GamePlayerSeatProps {
  /** Zero-based seat index (0 = bottom / 6 o'clock). */
  seatIndex: number;

  /**
   * The `GamePlayer` occupying this seat, or `null` for an empty/waiting slot.
   * Sourced from `useGameContext().players` or `useGameSocket().players`.
   */
  player: GamePlayer | null;

  /**
   * The current client's own player ID.
   * When it matches `player.playerId`, a "You" pill is rendered and the border
   * is highlighted in emerald regardless of team.
   */
  myPlayerId: string | null;

  /**
   * The player ID whose turn it currently is.
   * When it matches `player.playerId`, the seat-glow animation and a pulsing
   * amber ring are applied; the seat also scales up slightly to draw attention.
   */
  currentTurnPlayerId: string | null;

  /**
   * Explicit boolean override for the active-turn state.
   *
   * When provided, this takes precedence over the `currentTurnPlayerId` /
   * `player.isCurrentTurn` derivation.  Useful when the parent component
   * manages the turn flag independently (e.g. optimistic UI after action).
   *
   * Pass `false` (or omit) to rely on `currentTurnPlayerId` matching.
   */
  isActiveTurn?: boolean;

  /**
   * Per-card inference data for this player (from `useCardInference`).
   *
   * When provided and non-empty, an `<InferenceIndicator>` badge is rendered
   * below the team-dot row showing confirmed and excluded card counts.
   *
   * Pass the player's slice of `cardInferences[playerId]` from the
   * `InferenceContext` when inference mode is active.  Omit (or pass
   * `undefined`) to suppress the indicator when inference mode is off or
   * when no inference data exists for this player yet.
   *
   * Spectators always have inference mode active (enforced by
   * `InferenceProvider`); players can toggle it via the header button.
   */
  inference?: PlayerInference;

  /**
   * Uniform-distribution probability percentage (0–100) for this player.
   *
   * When provided and > 0, a cyan `~XX%` badge is displayed inside the
   * `<InferenceIndicator>` showing the player's share of unknown cards
   * under the uniform-distribution model.
   *
   * Pass `undefined` or `0` to suppress the badge (e.g. for the local
   * player whose cards are fully known, or when inference mode is off).
   */
  inferencePercent?: number;

  /** Extra Tailwind classes forwarded to the outermost element. */
  className?: string;
}

// ── Team style map ────────────────────────────────────────────────────────────

const TEAM_STYLES = {
  1: {
    dot: 'bg-emerald-500',
    border: 'border-emerald-600/50',
    bg: 'bg-emerald-900/30',
    ring: 'ring-emerald-500/30',
  },
  2: {
    dot: 'bg-violet-500',
    border: 'border-violet-600/50',
    bg: 'bg-violet-900/30',
    ring: 'ring-violet-500/30',
  },
} as const;

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * `GamePlayerSeat` renders a compact seat chip for the active game view.
 *
 * Accepts `GamePlayer | null` driven from live game socket state.
 */
const GamePlayerSeat: React.FC<GamePlayerSeatProps> = ({
  seatIndex,
  player,
  myPlayerId,
  currentTurnPlayerId,
  isActiveTurn,
  inference,
  inferencePercent,
  className = '',
}) => {
  // ── Empty seat ──────────────────────────────────────────────────────────────
  if (!player) {
    return (
      <div
        className={[
          'w-[6.5rem] flex flex-col items-center gap-1',
          'py-2 px-2 rounded-xl',
          'border border-dashed',
          'border-slate-700/60 bg-slate-900/60',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={`Seat ${seatIndex + 1} — waiting for player`}
        role="listitem"
        data-testid="game-player-seat-empty"
        data-seat-index={seatIndex}
      >
        <span
          className="text-base text-slate-700 animate-pulse"
          aria-hidden="true"
        >
          ⌛
        </span>
        <span className="text-[0.6rem] text-slate-600 font-medium">
          Waiting…
        </span>
      </div>
    );
  }

  // ── Derived flags ───────────────────────────────────────────────────────────
  const { playerId, displayName, avatarId, teamId, cardCount, isBot, isCurrentTurn } = player;

  const isMe = playerId === myPlayerId;

  // `isActiveTurn` prop (explicit override) takes precedence; otherwise derive
  // from currentTurnPlayerId match or the player's own isCurrentTurn flag.
  const isTurn = isActiveTurn !== undefined
    ? isActiveTurn
    : (playerId === currentTurnPlayerId || isCurrentTurn);

  const style = TEAM_STYLES[teamId] ?? TEAM_STYLES[1];

  // Has any inference data to display?
  const hasInference = inference !== undefined && Object.keys(inference).length > 0;

  // ── Occupied seat ───────────────────────────────────────────────────────────
  return (
    <div
      className={[
        'relative w-[6.5rem] flex flex-col items-center gap-1',
        'py-2 px-2 rounded-xl border',
        // Scale up slightly and elevate when it's this player's turn
        isTurn ? 'scale-110 z-10' : '',
        // Active-turn ring (layout layer — amber offset ring on the container)
        isTurn ? 'ring-2 ring-amber-400/80 ring-offset-1 ring-offset-slate-950' : '',
        // Active-turn glow animation (box-shadow keyframe from globals.css)
        isTurn ? 'animate-seat-glow' : '',
        // Current user always gets an emerald highlight
        isMe
          ? 'border-emerald-500/70 bg-emerald-900/40'
          : [style.border, style.bg].join(' '),
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`${displayName}${isMe ? ', you' : ''}${isBot ? ' (bot)' : ''}${isTurn ? ', current turn' : ''}`}
      role="listitem"
      data-testid="game-player-seat"
      data-seat-index={seatIndex}
      data-player-id={playerId}
      data-team={teamId}
      data-active-turn={isTurn ? 'true' : undefined}
    >
      {/* ── Current-turn pulsing ring ─────────────────────────────── */}
      {isTurn && (
        <span
          className="absolute inset-0 rounded-xl border-2 border-amber-400/80 animate-pulse pointer-events-none"
          aria-hidden="true"
          data-testid="turn-ring"
        />
      )}

      {/* ── Avatar with card-count badge ─────────────────────────── */}
      <div className="relative">
        <Avatar
          displayName={displayName}
          imageUrl={avatarId ?? undefined}
          size="sm"
          aria-label={undefined}
        />

        {/* Card count badge */}
        <span
          className={[
            'absolute -bottom-1 -right-1',
            'w-4 h-4 rounded-full flex items-center justify-center',
            'text-[9px] font-bold leading-none select-none',
            'border border-slate-700',
            cardCount === 0 ? 'bg-slate-800 text-slate-500' : 'bg-slate-900 text-slate-200',
          ].join(' ')}
          aria-label={`${cardCount} card${cardCount !== 1 ? 's' : ''}`}
          data-testid="card-count-badge"
        >
          {cardCount}
        </span>
      </div>

      {/* ── Name / bot badge ─────────────────────────────────────── */}
      {isBot ? (
        <BotBadge
          displayName={displayName}
          size="xs"
          showName={true}
          className="max-w-full"
        />
      ) : (
        <span
          className={[
            'text-[0.65rem] font-medium truncate w-full text-center',
            isMe ? 'text-emerald-300' : 'text-slate-300',
          ].join(' ')}
          title={displayName}
          data-testid="player-display-name"
        >
          {displayName}
        </span>
      )}

      {/* ── Team dot + "You" pill ─────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap justify-center min-h-[1rem]">
        <span
          className={['w-1.5 h-1.5 rounded-full flex-shrink-0', style.dot].join(' ')}
          aria-hidden="true"
          data-testid="team-dot"
        />
        {isMe && (
          <span
            className="
              text-[0.55rem] font-semibold uppercase tracking-wider
              bg-emerald-600/40 text-emerald-300
              px-1 py-0.5 rounded-full leading-none
            "
            aria-hidden="true"
            data-testid="you-pill"
          >
            You
          </span>
        )}
      </div>

      {/* ── Inference indicator (confirmed / excluded counts + uniform % badge) ── */}
      {(hasInference || (inferencePercent !== undefined && inferencePercent > 0)) && (
        <InferenceIndicator
          playerId={playerId}
          inference={inference ?? {}}
          sharePercent={inferencePercent}
          className="mt-0.5"
        />
      )}
    </div>
  );
};

export default GamePlayerSeat;
