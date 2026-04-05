'use client';

/**
 * CircularGameTable — replaces the two-row layout with a true circular
 * alternating seating arrangement.
 *
 * Literature is played with players sitting in a circle, alternating teams:
 * T1, T2, T1, T2, T1, T2 (6-player) or T1, T2, T1, T2 × 4 (8-player).
 *
 * The local player is always anchored at the bottom (6 o'clock), with
 * opponents and teammates alternating clockwise around the felt.
 *
 * ### Geometry
 * Seats are positioned along an ellipse using the clockwise-from-top formula:
 *   x = 50 + rx × sin(angleDeg)
 *   y = 50 - ry × cos(angleDeg)
 *
 * Starting at 180° (bottom) and decrementing by `step = 360 / count` each
 * seat produces a visually clockwise progression.
 *
 * ### Responsive
 * - Mobile  (<sm): container uses `aspect-[5/4]`, tighter radii (32%)
 * - Desktop (≥sm): container uses `aspect-[5/3]`, wider radii (34%)
 *
 * Both use the same percentage-based positioning so the layout scales
 * fluidly with the container width.
 */

import React from 'react';
import GamePlayerSeat from './GamePlayerSeat';
import type { GamePlayer } from '@/types/game';
import type { DeclarationSeatRevealCard } from '@/lib/declarationSeatReveal';
import { useVoice } from '@/contexts/VoiceContext';

// ── Geometry ───────────────────────────────────────────────────────────────────

interface SeatXY { x: number; y: number }

/**
 * Compute percentage-based (x, y) positions for `count` seats placed
 * clockwise around an ellipse, starting from 180° (bottom).
 *
 * A radius of `r = 34` means the seat centre is 34% of the container's
 * width/height away from the centre in each axis. Because the container uses
 * a landscape aspect ratio on desktop and a square-ish one on mobile, the
 * ellipse naturally fits the available space without manual tuning.
 */
function getCircularPositions(count: 6 | 8): SeatXY[] {
  const step = 360 / count;
  const r = count === 8 ? 33 : 34; // slightly tighter for 8-player

  return Array.from({ length: count }, (_, i) => {
    // Clockwise visually: subtract step each seat from the starting angle.
    const angleDeg = ((180 - i * step) + 360) % 360;
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: 50 + r * Math.sin(rad),
      y: 50 - r * Math.cos(rad),
    };
  });
}

/**
 * Reorder the player list (sorted by seatIndex) so the local player sits at
 * display index 0 (bottom), preserving the alternating T1-T2 pattern that
 * the server guarantees by assigning even seatIndices to T1 and odd to T2.
 */
function buildDisplaySlots(
  players: GamePlayer[],
  myPlayerId: string | null,
  playerCount: 6 | 8,
): (GamePlayer | null)[] {
  // Build a dense slot array keyed by seatIndex (null = empty seat)
  const byIndex: (GamePlayer | null)[] = Array.from(
    { length: playerCount },
    (_, i) => players.find((p) => p.seatIndex === i) ?? null,
  );

  const mySeatIndex = players.find((p) => p.playerId === myPlayerId)?.seatIndex ?? 0;

  // Rotate so local player's slot is first
  return [...byIndex.slice(mySeatIndex), ...byIndex.slice(0, mySeatIndex)];
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface CircularGameTableProps {
  players: GamePlayer[];
  myPlayerId: string | null;
  playerCount: 6 | 8;
  currentTurnPlayerId: string | null;
  indicatorActive: boolean;
  highlightedPlayerIds?: Set<string>;
  onSeatClick?: (playerId: string) => void;
  /** When provided, ALL player seats become directly tappable regardless of highlight state. Used by god-mode spectators. */
  onDirectSeatClick?: (playerId: string) => void;
  askTargetPlayerIds?: Set<string>;
  onAskTargetClick?: (playerId: string) => void;
  declarationSeatRevealByPlayerId?: Map<
    string,
    DeclarationSeatRevealCard[]
  > | null;
  /** Wraps individual seats — used by inline declare to make teammate seats droppable. */
  renderSeatWrapper?: (
    player: GamePlayer,
    seatElement: React.ReactNode,
  ) => React.ReactNode;
  /** DeclaredBooksTable rendered inside the table felt. */
  children?: React.ReactNode;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function CircularGameTable({
  players,
  myPlayerId,
  playerCount,
  currentTurnPlayerId,
  indicatorActive,
  highlightedPlayerIds,
  onSeatClick,
  onDirectSeatClick,
  askTargetPlayerIds,
  onAskTargetClick,
  declarationSeatRevealByPlayerId,
  renderSeatWrapper,
  children,
}: CircularGameTableProps) {
  const { getSeatState } = useVoice();

  const displaySlots = buildDisplaySlots(players, myPlayerId, playerCount);
  const positions     = getCircularPositions(playerCount);

  return (
    <div
      className="relative w-full aspect-[5/4] sm:aspect-[5/3] max-h-full mx-auto"
      aria-label="Game table — players seated in a circle, alternating teams"
      data-testid="circular-game-table"
    >
      {/* ── Table felt ─────────────────────────────────────────────────────── */}
      {/* Inset oval representing the green card-table surface */}
      <div
        className={[
          'absolute rounded-[50%]',
          'bg-gradient-to-br from-emerald-950 via-emerald-900/90 to-emerald-950',
          'border border-emerald-700/25',
          'shadow-[inset_0_4px_60px_rgba(0,0,0,0.55),inset_0_0_0_1px_rgba(52,211,153,0.06)]',
        ].join(' ')}
        style={{ left: '24%', top: '22%', width: '52%', height: '56%' }}
        aria-hidden="true"
      >
        {/* Subtle double-ring rim — evokes the wooden rail of a card table */}
        <div className="absolute inset-[6px] rounded-[50%] border border-emerald-800/20" />
        <div className="absolute inset-[2px] rounded-[50%] border border-emerald-700/10" />
      </div>

      {/* ── Center content (DeclaredBooksTable) ────────────────────────────── */}
      <div
        className="absolute"
        style={{ left: '24%', top: '22%', width: '52%', height: '56%' }}
        data-testid="game-table-center"
      >
        <div className="h-full flex items-center justify-center p-2 sm:p-3">
          {children}
        </div>
      </div>

      {/* ── Player seats ───────────────────────────────────────────────────── */}
      {displaySlots.map((player, displayIdx) => {
        const pos = positions[displayIdx];
        if (!pos) return null;

        const playerId  = player?.playerId ?? null;
        const isHl      = Boolean(playerId && highlightedPlayerIds?.has(playerId));
        const isAskTgt  = Boolean(playerId && askTargetPlayerIds?.has(playerId));

        const seatElement = (
          <GamePlayerSeat
            key={playerId ?? `empty-${displayIdx}`}
            seatIndex={player?.seatIndex ?? displayIdx}
            player={player}
            myPlayerId={myPlayerId}
            currentTurnPlayerId={currentTurnPlayerId}
            isActiveTurn={
              playerId === myPlayerId ? indicatorActive : undefined
            }
            voiceState={playerId ? getSeatState(playerId) : null}
            isHighlighted={isHl}
            onHighlightClick={
              isHl && onSeatClick && playerId
                ? () => onSeatClick(playerId)
                : undefined
            }
            onDirectClick={
              onDirectSeatClick && playerId
                ? () => onDirectSeatClick(playerId)
                : undefined
            }
            isAskTargetable={isAskTgt}
            onAskTargetClick={
              isAskTgt && onAskTargetClick && playerId
                ? () => onAskTargetClick(playerId)
                : undefined
            }
            declarationRevealCards={
              playerId
                ? (declarationSeatRevealByPlayerId?.get(playerId) ?? null)
                : null
            }
            compact={playerCount === 8}
          />
        );

        const content =
          player && renderSeatWrapper
            ? renderSeatWrapper(player, seatElement)
            : seatElement;

        return (
          <div
            key={playerId ?? `slot-${displayIdx}`}
            className="absolute"
            style={{
              left: `${pos.x}%`,
              top: `${pos.y}%`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
