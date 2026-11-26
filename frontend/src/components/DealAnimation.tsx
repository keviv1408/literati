'use client';

import { useEffect, type CSSProperties } from 'react';
import { backUrl } from '@/lib/cardDeck';

interface DealSeat {
  seatIndex: number;
  x: number;
  y: number;
}

const CARD_COUNT = 48;
const SHUFFLE_MS = 480;
const FLIGHT_MS = 240;
const INTERVAL_MS = 18;
const LAST_LAUNCH_MS = SHUFFLE_MS + (CARD_COUNT - 1) * INTERVAL_MS;

export default function DealAnimation({ seats, onComplete }: { seats: DealSeat[]; onComplete: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onComplete, LAST_LAUNCH_MS + FLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [onComplete]);

  if (!seats.length) return null;
  // Seat zero on screen is at six o'clock. The table lays the rest out to its right.
  const clockwise = [seats[0], ...seats.slice(1).reverse()];
  return (
    <div
      aria-hidden="true"
      data-testid="deal-animation"
      className="opening-deal pointer-events-none absolute inset-0 z-20"
      style={{ '--back': `url("${backUrl}")`, '--last-launch': `${LAST_LAUNCH_MS}ms` } as CSSProperties}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          className="deal-back deal-packet"
          style={{
            '--side': i % 2 ? 1 : -1,
            '--edge': `${(5 - i) * 0.6}px`,
            '--riffle-time': `${SHUFFLE_MS - (5 - i) * 14}ms`,
          } as CSSProperties}
        />
      ))}
      {Array.from({ length: CARD_COUNT }, (_, i) => {
        const seat = clockwise[i % clockwise.length];
        return (
          <span
            key={i}
            className="deal-back deal-flight"
            data-deal-seat={seat.seatIndex}
            style={{
              '--dx': `${seat.x - 50}cqw`,
              '--dy': `${seat.y - 50}cqh`,
              '--tilt': `${(seat.x - 50) / 2}deg`,
              animationDuration: `${FLIGHT_MS}ms`,
              animationDelay: `${SHUFFLE_MS + i * INTERVAL_MS}ms`,
            } as CSSProperties}
          />
        );
      })}
    </div>
  );
}
