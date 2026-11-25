import posthog from 'posthog-js';
import type { CaptureResult, Properties } from 'posthog-js';
import type { PublicGameState } from '@/types/game';

const _URL_KEY = /url|href|referrer/i;

function _markerKey(roomCode: string): string {
  return `literati:game-counted:${roomCode}`;
}

function _capture(event: string, props: Properties): void {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  posthog.capture(event, props);
}

function _stripUrls(props: Properties): Properties {
  return Object.fromEntries(
    Object.entries(props).map(([key, value]) => [
      key,
      _URL_KEY.test(key) && typeof value === 'string' ? value.split(/[?#]/, 1)[0] : value,
    ]),
  );
}

export function trackGameInit(
  roomCode: string,
  status: PublicGameState['status'] | undefined,
  playerCount: number,
): void {
  try {
    if (status !== 'active') return;
    const key = _markerKey(roomCode);
    // A reload replays game_init; the marker keeps it from counting twice.
    if (localStorage.getItem(key) !== null) return;
    localStorage.setItem(key, String(playerCount));
    _capture('game_started', { player_count: playerCount });
  } catch {
    // Tracking must never break the game.
  }
}

export function trackGameOver(roomCode: string): void {
  try {
    const key = _markerKey(roomCode);
    const stored = localStorage.getItem(key);
    if (stored === null) return;
    // Removing the marker lets a rematch in the same room count as a new game.
    localStorage.removeItem(key);
    _capture('game_finished', { player_count: Number(stored) });
  } catch {
    // Tracking must never break the game.
  }
}

export function trackSocketDropped(closeCode: number): void {
  try {
    _capture('game_socket_dropped', { close_code: closeCode });
  } catch {
    // Tracking must never break the game.
  }
}

export function redactUrls(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  return {
    ...event,
    properties: _stripUrls(event.properties),
    ...(event.$set && { $set: _stripUrls(event.$set) }),
    ...(event.$set_once && { $set_once: _stripUrls(event.$set_once) }),
  };
}
