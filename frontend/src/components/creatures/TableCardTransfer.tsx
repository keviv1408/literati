'use client';

import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AskDeniedCueState, CardFlightState } from '@/hooks/useAskResultAnimations';
import CardFlightAnimation, { FLIGHT_DURATION_MS } from '../CardFlightAnimation';
import type { createRetrievalScene } from './retrievalScene';
import { isCreatureKind } from './kind';
import AskDeniedAnimation, { ASK_DENIED_ANIMATION_MS } from '../AskDeniedAnimation';

export default function TableCardTransfer({ flight, denial, onComplete }: {
  flight: CardFlightState | null;
  denial?: AskDeniedCueState | null;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const factoryRef = useRef<typeof createRetrievalScene | null>(null);
  const sceneRef = useRef<ReturnType<typeof createRetrievalScene>>(null);
  const activeSceneFlight = useRef<CardFlightState | null>(null);
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
        scene?.warm(new Set(Array.from(avatars, avatar => avatar.dataset.creature).filter(isCreatureKind)));
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
    activeSceneFlight.current = null;
    const canvas = canvasRef.current;
    const card = cardRef.current;
    if ((!flight && !denial) || !canvas || !factoryRef.current) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    function findSeat(playerId: string) {
      const avatar = canvas?.parentElement?.querySelector<HTMLElement>(
        `[data-player-id="${CSS.escape(playerId)}"] .speech-avatar[data-creature]`,
      );
      const kind = avatar?.dataset.creature;
      if (!avatar || !isCreatureKind(kind)) return;
      const rect = avatar.getBoundingClientRect();
      if (!rect.width) return;
      return { avatar, kind, seat: {
        x: rect.left - bounds.left + rect.width / 2,
        y: rect.top - bounds.top + rect.height / 2,
        size: rect.width,
      } };
    }
    const scene = sceneRef.current ??= factoryRef.current(canvas);
    if (!scene) return;
    let cancelled = false;
    if (denial) {
      const giver = findSeat(denial.targetId);
      const asker = findSeat(denial.askerId);
      if (!giver || !asker) return;
      giver.avatar.dataset.denialRole = 'giver';
      asker.avatar.dataset.denialRole = 'asker';
      scene.deny([{ ...giver, role: 'giver' }, { ...asker, role: 'asker' }], ASK_DENIED_ANIMATION_MS, () => {
        delete giver.avatar.dataset.denialRole;
        delete asker.avatar.dataset.denialRole;
      });
    } else if (flight && card) {
      const asker = findSeat(flight.askerId);
      if (!asker) return;
      asker.avatar.dataset.retrieving = '';
      card.dataset.retrieving = asker.kind;
      scene.play({
        kind: asker.kind, card, duration: FLIGHT_DURATION_MS,
        source: { x: flight.fromX, y: flight.fromY }, home: asker.seat,
      }, () => {
        delete asker.avatar.dataset.retrieving;
        delete card.dataset.retrieving;
        if (!cancelled && activeSceneFlight.current === flight) finish();
      });
      if (card.hasAttribute('data-retrieving')) activeSceneFlight.current = flight;
    }
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
  }, [flight, denial]);

  return <>
    <canvas ref={canvasRef} className="creature-retrieval" aria-hidden="true" />
    {denial && createPortal(<AskDeniedAnimation cue={denial} onComplete={onComplete} />, denial.seat)}
    {flight && <CardFlightAnimation {...flight} cardRef={cardRef} onComplete={() => {
      if (activeSceneFlight.current !== flight) onComplete();
    }} />}
  </>;
}
