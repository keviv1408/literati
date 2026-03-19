'use client';

/**
 * DealAnimation — Cinematic Dealer
 *
 * A four-phase card deal animation overlay:
 *
 *   Phase 1 — GATHER  (400 ms) : Cards compress into a tight stack with 3D tilt
 *   Phase 2 — RIFFLE  (600 ms) : Deck splits, cards interleave, emerald particles scatter
 *   Phase 3 — DEAL   (2000 ms) : Cards spiral outward in 3D arcs with light trails
 *   Phase 4 — done              : Component unmounts
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
const GATHER_MS = 400;
const RIFFLE_MS = 600;
const DEAL_CARD_MS = 720;
const DEAL_STAGGER_MS = 50;
const DEAL_FINISH_BUFFER_MS = 300;
const TOTAL_CARDS = 48;
const DECK_STACK_SIZE = 10;
const PARTICLE_COUNT = 16;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DealAnimationProps {
  playerCount: 6 | 8;
  onComplete: () => void;
}

type Phase = 'gathering' | 'riffling' | 'dealing' | 'done';

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
  /** Mid-flight 3D rotateX */
  rxMid: number;
  /** Mid-flight 3D rotateY */
  ryMid: number;
  /** Angle from center to seat (degrees) — used for trail rotation */
  angleDeg: number;
}

interface Particle {
  key: string;
  dx: number;
  dy: number;
  delay: number;
  size: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardsPerPlayer(playerCount: 6 | 8): number {
  return TOTAL_CARDS / playerCount;
}

function getTotalAnimationMs(playerCount: 6 | 8): number {
  return GATHER_MS
    + RIFFLE_MS
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
    const fanOffset = (round - (cardsPerPlayer - 1) / 2) * 10;
    const radialLiftX = Math.sin(angleRad) * 20;
    const radialLiftY = -Math.cos(angleRad) * 16;

    // 3D rotation at mid-flight — cards spin based on their direction
    const rxMid = -12 + Math.sin(angleRad) * 18;
    const ryMid = 15 + Math.cos(angleRad) * 20;

    return {
      key: `deal-${dealIndex}`,
      seatIndex: seat.seatIndex,
      round,
      dx: seat.x - TABLE_CX + tangentX * fanOffset + radialLiftX,
      dy: seat.y - TABLE_CY + tangentY * fanOffset + radialLiftY,
      delay: dealIndex * DEAL_STAGGER_MS,
      lift: 24 + (round % 3) * 8,
      rotationEnd: fanOffset * 0.2,
      scaleEnd: 0.72 + (round % 2) * 0.04,
      rxMid,
      ryMid,
      angleDeg: seat.angleDeg,
    };
  });
}

function buildParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
    const distance = 40 + Math.random() * 50;
    return {
      key: `particle-${i}`,
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      delay: Math.random() * 200,
      size: 3 + Math.random() * 4,
    };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DealAnimation({ playerCount, onComplete }: DealAnimationProps) {
  const [phase, setPhase] = useState<Phase>('gathering');
  const dealFlights = useMemo(() => buildDealFlights(playerCount), [playerCount]);
  const particles = useMemo(() => buildParticles(), []);
  const totalAnimationMs = useMemo(() => getTotalAnimationMs(playerCount), [playerCount]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('riffling'), GATHER_MS);
    const t2 = setTimeout(() => setPhase('dealing'), GATHER_MS + RIFFLE_MS);
    const t3 = setTimeout(() => {
      setPhase('done');
      onCompleteRef.current();
    }, totalAnimationMs);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [totalAnimationMs]);

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
        {/* ── Center deck area ─────────────────────────────────────────── */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {/* Emerald glow — intensifies during gather, pulses during riffle */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400 blur-3xl transition-all duration-500"
            style={{
              width: phase === 'dealing' ? '12rem' : phase === 'riffling' ? '14rem' : '10rem',
              height: phase === 'dealing' ? '12rem' : phase === 'riffling' ? '14rem' : '10rem',
              opacity: phase === 'dealing' ? 0.06 : phase === 'riffling' ? 0.18 : 0.1,
            }}
          />

          {/* ── Riffle particles ───────────────────────────────── */}
          {phase === 'riffling' && particles.map((p) => (
            <div
              key={p.key}
              className="absolute left-1/2 top-1/2 rounded-full bg-emerald-400 animate-riffle-particle"
              style={{
                width: p.size,
                height: p.size,
                '--particle-dx': `${p.dx}px`,
                '--particle-dy': `${p.dy}px`,
                animationDelay: `${p.delay}ms`,
                marginLeft: -p.size / 2,
                marginTop: -p.size / 2,
              } as CSSProperties}
            />
          ))}

          {/* ── Card deck stack ────────────────────────────────── */}
          <div
            className={
              phase === 'gathering' ? 'animate-deck-gather relative' :
              phase === 'riffling' ? 'relative' :
              'relative'
            }
            style={{ transformStyle: 'preserve-3d' }}
            data-testid="deal-animation-deck"
          >
            {phase !== 'dealing' && Array.from({ length: DECK_STACK_SIZE }, (_, stackIdx) => {
              const isLeftHalf = stackIdx < DECK_STACK_SIZE / 2;
              const riffleClass = phase === 'riffling'
                ? (isLeftHalf ? 'animate-riffle-left' : 'animate-riffle-right')
                : '';

              return (
                <div
                  key={stackIdx}
                  className={`absolute left-1/2 top-1/2 -ml-8 -mt-12 ${riffleClass}`}
                  style={{
                    transform: phase === 'gathering'
                      ? `translate(${(stackIdx - 4.5) * 1.2}px, ${stackIdx * 0.7}px) rotate(${(stackIdx - 4.5) * 1.8}deg)`
                      : `translate(${(stackIdx - 4.5) * 0.4}px, ${stackIdx * 0.3}px) rotate(${(stackIdx - 4.5) * 0.5}deg)`,
                    opacity: 0.5 + stackIdx * 0.05,
                    zIndex: stackIdx,
                    transition: 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
                    animationDelay: phase === 'riffling' ? `${stackIdx * 30}ms` : undefined,
                  }}
                >
                  <PlayingCard
                    cardId="1_s"
                    faceDown={true}
                    size="lg"
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Flying cards with light trails ─────────────────────────── */}
        {phase === 'dealing' &&
          dealFlights.map((flight) => (
            <div key={flight.key} className="contents">
              {/* Light trail — emerald streak behind the card */}
              <div
                className="absolute left-1/2 top-1/2 animate-deal-trail"
                style={{
                  '--deal-dx': `${flight.dx}px`,
                  '--deal-dy': `${flight.dy}px`,
                  '--deal-lift': `${flight.lift}px`,
                  animationDelay: `${flight.delay}ms`,
                  animationDuration: `${DEAL_CARD_MS * 0.6}ms`,
                  width: 32,
                  height: 3,
                  marginLeft: -16,
                  marginTop: -1.5,
                  background: 'linear-gradient(90deg, transparent, rgba(110, 231, 183, 0.5), transparent)',
                  borderRadius: 2,
                  transform: `rotate(${flight.angleDeg - 90}deg)`,
                  transformOrigin: 'center',
                  zIndex: 55 + flight.round,
                } as CSSProperties}
              />

              {/* The flying card */}
              <div
                data-testid="deal-animation-card"
                data-seat-index={flight.seatIndex}
                data-deal-round={flight.round}
                className="absolute left-1/2 top-1/2 -ml-8 -mt-12 animate-card-deal"
                style={{
                  '--deal-dx': `${flight.dx}px`,
                  '--deal-dy': `${flight.dy}px`,
                  '--deal-lift': `${flight.lift}px`,
                  '--deal-rx-mid': `${flight.rxMid}deg`,
                  '--deal-ry-mid': `${flight.ryMid}deg`,
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

              {/* Seat glow — pulse at landing position */}
              <div
                className="absolute left-1/2 top-1/2 animate-deal-seat-glow"
                style={{
                  animationDelay: `${flight.delay + DEAL_CARD_MS * 0.85}ms`,
                  width: 24,
                  height: 24,
                  marginLeft: -12 + flight.dx,
                  marginTop: -12 + flight.dy,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle, rgba(110, 231, 183, 0.4), transparent 70%)',
                  zIndex: 50,
                } as CSSProperties}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
