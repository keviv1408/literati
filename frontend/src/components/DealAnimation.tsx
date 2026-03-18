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

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import PlayingCard from './PlayingCard';
import {
  TABLE_CX,
  TABLE_CY,
  VIEWBOX_HEIGHT,
  VIEWBOX_WIDTH,
  getSeatPositions,
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
  const dealFlights = useMemo(() => buildDealFlights(playerCount), [playerCount]);
  const totalAnimationMs = useMemo(() => getTotalAnimationMs(playerCount), [playerCount]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('dealing'), SHUFFLE_MS);
    const t2 = setTimeout(() => {
      setPhase('done');
      onCompleteRef.current();
    }, totalAnimationMs);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [totalAnimationMs]);

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
