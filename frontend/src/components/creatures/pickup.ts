import { Group, Vector2, Vector3 } from 'three';
import type { Pose } from './geometry';
import type { CreatureKind } from './kind';
import { coastPickups } from './trioCoast';
import { forestPickups } from './trioForest';
import { wildPickups } from './trioWild';

interface Placement {
  travel: number;
  carrying: boolean;
  lift?: number;
  sway?: number;
  roll?: number;
  yaw?: number;
  scale?: number;
  cardRoll?: number;
  cardLift?: number;
}

export interface PickupContext {
  kind: CreatureKind;
  distance: number;
  direction: number;
  size: number;
  home: Vector2;
  source: Vector2;
  actor: Group;
  effects: Group;
  grip: Vector3;
  cardHalf: Vector2;
  cardEdge: Vector2;
  cardScale: number;
  place: (placement: Placement) => void;
  placeCard: (x: number, y: number, roll?: number) => void;
}

const PICKUPS = { ...coastPickups, ...forestPickups, ...wildPickups };
type PickupKind = keyof typeof PICKUPS;

export function createPickupMotion(kind: PickupKind, home: Vector2, source: Vector2, size: number,
  actor: Group, pose: Pose, effects: Group, card: HTMLElement) {
  const hand = actor.getObjectByName('card-grip')!;
  const grip = new Vector3();
  const line = source.clone().sub(home);
  const distance = line.length();
  const normal = new Vector2(-line.y, line.x).normalize();
  const half = new Vector2((card.offsetWidth || 48) / 2, (card.offsetHeight || 72) / 2);
  const restScale = Math.min(1, Math.max(0.8, size / 48));
  const edge = line.clone().multiplyScalar(-1 / Math.max(Math.abs(line.x) / half.x, Math.abs(line.y) / half.y, 1));
  const contactOffset = new Vector2();
  let attached = false;
  const ctx: PickupContext = {
    kind, home, source, size, distance, direction: line.x >= 0 ? 1 : -1,
    actor, effects, grip, cardHalf: half, cardEdge: edge, cardScale: restScale,
    placeCard(x, y, roll = 0) {
      card.style.transform = `translate3d(${x - source.x}px,${source.y - y}px,0) rotate(${-roll}rad) scale(${ctx.cardScale})`;
    },
    place({ travel, carrying, lift = 0, sway = 0, roll = 0, yaw = 0, scale = 1, cardRoll = 0, cardLift = 0 }) {
      actor.position.set(home.x + line.x * travel + normal.x * sway * size,
        home.y + line.y * travel + (lift + normal.y * sway) * size, 0);
      actor.rotation.set(0, yaw, roll);
      actor.scale.setScalar(size / 2.28 * scale);
      hand.getWorldPosition(grip);
      // At contact the animated grip meets the near edge without moving the waiting card.
      if (!attached) {
        contactOffset.set(edge.x * restScale - (grip.x - actor.position.x),
          edge.y * restScale - (grip.y - actor.position.y));
        attached = carrying;
      }
      const x = contactOffset.x * travel;
      const y = contactOffset.y * travel;
      actor.position.x += x;
      actor.position.y += y;
      grip.x += x;
      grip.y += y;
      if (carrying) {
        const cosine = Math.cos(cardRoll), sine = Math.sin(cardRoll);
        ctx.placeCard(grip.x - ctx.cardScale * (edge.x * cosine - edge.y * sine),
          grip.y - ctx.cardScale * (edge.x * sine + edge.y * cosine) + cardLift * size, cardRoll);
      } else {
        ctx.placeCard(source.x, source.y);
      }
    },
  };
  const move = PICKUPS[kind](ctx);
  return (t: number) => {
    const activity = Math.min(1, t / 0.12, (1 - t) / 0.11);
    pose(activity, t);
    const settle = Math.max(0, Math.min(1, (t - 0.83) / 0.12));
    ctx.cardScale = restScale * (1 - 0.82 * settle);
    card.style.opacity = String(Math.min(1, t / 0.06) * (1 - settle));
    move(t);
  };
}
