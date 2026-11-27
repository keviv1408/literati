'use client';

import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { CardFlightState } from '@/hooks/useAskResultAnimations';
import CardFlightAnimation, { FLIGHT_DURATION_MS } from '../CardFlightAnimation';
import type { createRetrievalScene } from './retrievalScene';
import type { CreatureKind } from './models';

function _kind(value?: string): value is CreatureKind {
  return value === 'frog' || value === 'octopus' || value === 'butterfly';
}

export default function TableCardTransfer({ flight, onComplete }: {
  flight: CardFlightState | null;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const factoryRef = useRef<typeof createRetrievalScene | null>(null);
  const sceneRef = useRef<ReturnType<typeof createRetrievalScene>>(null);
  const ownedFlight = useRef<CardFlightState | null>(null);
  const finish = useEffectEvent(onComplete);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !window.WebGL2RenderingContext || !window.ResizeObserver) return;
    let cancelled = false;
    import('./retrievalScene').then(({ createRetrievalScene }) => {
      if (cancelled) return;
      factoryRef.current = createRetrievalScene;
      const avatars = canvas.parentElement?.querySelectorAll<HTMLElement>('.speech-avatar[data-creature]');
      if (avatars?.length && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const scene = createRetrievalScene(canvas);
        sceneRef.current = scene;
        scene?.warm(new Set(Array.from(avatars, avatar => avatar.dataset.creature).filter(_kind)));
      }
    }).catch(() => {
      // The normal card transfer also works when graphics are unavailable.
    });
    return () => {
      cancelled = true;
      factoryRef.current = null;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    ownedFlight.current = null;
    const canvas = canvasRef.current;
    const card = cardRef.current;
    if (!flight || !canvas || !card || !factoryRef.current) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return;
    const avatar = canvas.parentElement?.querySelector<HTMLElement>(
      `[data-player-id="${CSS.escape(flight.askerId)}"] .speech-avatar[data-creature]`,
    );
    const kind = avatar?.dataset.creature;
    if (!avatar || !_kind(kind)) return;
    const scene = sceneRef.current ??= factoryRef.current(canvas);
    if (!scene) return;
    const bounds = canvas.getBoundingClientRect();
    const seat = avatar.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !seat.width) return;

    avatar.dataset.retrieving = '';
    card.dataset.retrieving = kind;
    let cancelled = false;
    scene.play({
      kind, card, duration: FLIGHT_DURATION_MS,
      source: { x: flight.fromX, y: flight.fromY },
      home: { x: seat.left - bounds.left + seat.width / 2, y: seat.top - bounds.top + seat.height / 2, size: seat.width },
    }, () => {
      delete avatar.dataset.retrieving;
      delete card.dataset.retrieving;
      if (!cancelled && ownedFlight.current === flight) finish();
    });
    if (card.hasAttribute('data-retrieving')) ownedFlight.current = flight;

    const stop = () => scene.stop();
    const observer = new ResizeObserver(() => {
      const now = canvas.getBoundingClientRect();
      if (Math.abs(now.width - bounds.width) > 1 || Math.abs(now.height - bounds.height) > 1) stop();
    });
    observer.observe(canvas);
    motion.addEventListener('change', stop);
    return () => {
      cancelled = true;
      observer.disconnect();
      motion.removeEventListener('change', stop);
      stop();
    };
  }, [flight]);

  return <>
    <canvas ref={canvasRef} className="creature-retrieval" aria-hidden="true" />
    {flight && <CardFlightAnimation {...flight} cardRef={cardRef} onComplete={() => {
      if (ownedFlight.current !== flight) onComplete();
    }} />}
  </>;
}
