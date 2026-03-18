'use client';

/**
 * DealAnimation — overlays a brief card shuffle + deal animation (~1.4 s).
 *
 * Triggered once when `game_init` is first received (fresh deal).
 * Does NOT fire on reconnect / page-refresh (the parent uses a ref-guard).
 *
 * Visual sequence
 * ───────────────
 *   0 – 400 ms  : deck shuffle  (the stacked face-down cards wobble)
 *   400 – 1400 ms: deal phase   (face-down cards fly outward, one per player)
 *   1400 ms     : onComplete() fires and the component unmounts
 *
 * The overlay is `aria-hidden` and `pointer-events-none` so it never blocks
 * game controls or the accessibility tree while it plays.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import PlayingCard from './PlayingCard';
import {
  TABLE_CX,
  TABLE_CY,
  VIEWBOX_HEIGHT,
  VIEWBOX_WIDTH,
  getSeatPositions,
  toCssPercent,
} from '@/utils/seatPositions';

// ── Timing constants ──────────────────────────────────────────────────────────
const SHUFFLE_MS = 700;
const DEAL_CARD_MS = 620;
const DEAL_STAGGER_MS = 32;
const DEAL_FINISH_BUFFER_MS = 240;
const TOTAL_CARDS = 48;
const DECK_STACK_SIZE = 8;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DealAnimationProps {
  /**
   * Total number of players (6 or 8).
   * Controls the number of flying cards — one per player, spread evenly.
   */
  playerCount: 6 | 8;
  /** Called once the full animation has finished. */
  onComplete: () => void;
}

type Phase = 'shuffling' | 'dealing' | 'done';

interface DealFlight {
  key: string;
  seatIndex: number;
  round: number;
  dx: number;
  dy: number;
  delay: number;
  lift: number;
  rotationEnd: number;
  scaleEnd: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardsPerPlayer(playerCount: 6 | 8): number {
  return TOTAL_CARDS / playerCount;
}

function getTotalAnimationMs(playerCount: 6 | 8): number {
  return SHUFFLE_MS
    + (getCardsPerPlayer(playerCount) * playerCount - 1) * DEAL_STAGGER_MS
    + DEAL_CARD_MS
    + DEAL_FINISH_BUFFER_MS;
}

function buildDealFlights(playerCount: 6 | 8): DealFlight[] {
  const seatTargets = getSeatPositions(playerCount);
  const cardsPerPlayer = getCardsPerPlayer(playerCount);

  return Array.from({ length: TOTAL_CARDS }, (_, dealIndex) => {
    const seat = seatTargets[dealIndex % playerCount];
    const round = Math.floor(dealIndex / playerCount);
    const angleRad = (seat.angleDeg * Math.PI) / 180;
    const tangentX = Math.cos(angleRad);
    const tangentY = Math.sin(angleRad);
    const fanOffset = (round - (cardsPerPlayer - 1) / 2) * 12;
    const radialLiftX = Math.sin(angleRad) * 18;
    const radialLiftY = -Math.cos(angleRad) * 14;

    return {
      key: `deal-${dealIndex}`,
      seatIndex: seat.seatIndex,
      round,
      dx: seat.x - TABLE_CX + tangentX * fanOffset + radialLiftX,
      dy: seat.y - TABLE_CY + tangentY * fanOffset + radialLiftY,
      delay: dealIndex * DEAL_STAGGER_MS,
      lift: 20 + (round % 3) * 6,
      rotationEnd: fanOffset * 0.24 + (seat.angleDeg < 180 ? -8 : 8),
      scaleEnd: 0.72 + (round % 2) * 0.04,
    };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DealAnimation({ playerCount, onComplete }: DealAnimationProps) {
  const [phase, setPhase] = useState<Phase>('shuffling');
  const cardsPerPlayer = getCardsPerPlayer(playerCount);
  const seatTargets = useMemo(() => getSeatPositions(playerCount), [playerCount]);
  const dealFlights = useMemo(() => buildDealFlights(playerCount), [playerCount]);
  const totalAnimationMs = useMemo(() => getTotalAnimationMs(playerCount), [playerCount]);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('dealing'), SHUFFLE_MS);
    const t2 = setTimeout(() => {
      setPhase('done');
      onComplete();
    }, totalAnimationMs);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [onComplete, totalAnimationMs]);

  // Once the phase is 'done' the component renders nothing — it unmounts.
  if (phase === 'done') return null;

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
      aria-hidden="true"
      data-testid="deal-animation"
    >
      <div
        className="relative w-[min(94vw,72rem)] max-w-[72rem]"
        style={{ aspectRatio: `${VIEWBOX_WIDTH} / ${VIEWBOX_HEIGHT}` }}
      >
        <div className="absolute inset-[16%_18%] rounded-[999px] border border-emerald-300/12 bg-[radial-gradient(circle_at_50%_25%,rgba(16,185,129,0.12),transparent_40%),linear-gradient(180deg,rgba(15,23,42,0.08),rgba(2,6,23,0.26))] shadow-[inset_0_0_0_1px_rgba(16,185,129,0.06),0_22px_60px_rgba(2,6,23,0.4)]" />

        {seatTargets.map(({ seatIndex, x, y }) => (
          <div
            key={seatIndex}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: toCssPercent(x, 'width'), top: toCssPercent(y, 'height') }}
            data-testid="deal-seat-target"
            data-seat-index={seatIndex}
          >
            <div className="flex flex-col items-center gap-1">
              <div
                className="animate-deal-seat-pulse flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-slate-950/75 shadow-[0_8px_18px_rgba(2,6,23,0.34)]"
                style={{ animationDelay: `${seatIndex * 80}ms` }}
              >
                <span
                  className={[
                    'h-2.5 w-2.5 rounded-full',
                    seatIndex % 2 === 0 ? 'bg-emerald-400/90' : 'bg-violet-400/90',
                  ].join(' ')}
                />
              </div>
              <div className="rounded-full border border-white/8 bg-slate-950/75 px-2 py-0.5 text-[10px] font-semibold tracking-[0.2em] text-slate-400">
                {cardsPerPlayer}
              </div>
            </div>
          </div>
        ))}

        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute left-1/2 top-1/2 h-36 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/12 blur-3xl" />
          <div
            className={phase === 'shuffling' ? 'animate-deck-shuffle relative' : 'relative'}
            data-testid="deal-animation-deck"
          >
            {Array.from({ length: DECK_STACK_SIZE }, (_, stackIdx) => (
              <div
                key={stackIdx}
                className="absolute left-1/2 top-1/2 -ml-8 -mt-12"
                style={{
                  transform: `translate(${(stackIdx - 3.5) * 1.4}px, ${stackIdx * 0.9}px) rotate(${(stackIdx - 3.5) * 2.1}deg)`,
                  opacity: 0.42 + stackIdx * 0.07,
                  zIndex: stackIdx,
                }}
              >
                <PlayingCard
                  cardId="1_s"
                  faceDown={true}
                  size="lg"
                />
              </div>
            ))}
            <div className="animate-deck-riffle absolute left-1/2 top-1/2 -ml-8 -mt-12 origin-bottom-left opacity-80">
              <PlayingCard
                cardId="1_s"
                faceDown={true}
                size="lg"
              />
            </div>
            <div className="animate-deck-riffle absolute left-1/2 top-1/2 -ml-8 -mt-12 origin-bottom-right opacity-75 [animation-delay:120ms]">
              <PlayingCard
                cardId="1_s"
                faceDown={true}
                size="lg"
              />
            </div>
          </div>
        </div>

        {phase === 'dealing' &&
          dealFlights.map((flight) => (
            <div
              key={flight.key}
              data-testid="deal-animation-card"
              data-seat-index={flight.seatIndex}
              data-deal-round={flight.round}
              className="absolute left-1/2 top-1/2 -ml-8 -mt-12 animate-card-deal"
              style={{
                '--deal-dx': `${flight.dx}px`,
                '--deal-dy': `${flight.dy}px`,
                '--deal-lift': `${flight.lift}px`,
                '--deal-rot-end': `${flight.rotationEnd}deg`,
                '--deal-scale-end': `${flight.scaleEnd}`,
                animationDelay: `${flight.delay}ms`,
                animationDuration: `${DEAL_CARD_MS}ms`,
                zIndex: 60 + flight.round,
              } as CSSProperties}
            >
              <PlayingCard
                cardId="1_s"
                faceDown={true}
                size="lg"
              />
            </div>
          ))}
      </div>
    </div>
  );
}
