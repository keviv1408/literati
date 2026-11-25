import posthog from 'posthog-js';
import type { CaptureResult, Properties } from 'posthog-js';
import type { PublicGameState } from '@/types/game';

const _SOCKET_DROPPED_KEY = 'literati:socket-dropped';
const _URL_KEY = /url|href|referrer|filename/i;
const _URL_IN_TEXT = /([a-z][a-z0-9+.-]{0,31}:\/\/[^\s?#'"`<>]*)[?#][^\s'"`<>]*/gi;

function _markerKey(roomCode: string): string {
  return `literati:game-counted:${roomCode}`;
}

function _capture(event: string, props: Properties): void {
  if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || !process.env.NEXT_PUBLIC_POSTHOG_HOST) return;
  posthog.capture(event, props);
}

export function captureAnalyticsEvent(event: string, props: Properties = {}): void {
  try {
    _capture(event, props);
  } catch {
    // Tracking must never break the app.
  }
}

// The dedicated PostHog logger exports only the structured lines added by this integration.
export function logGameFlow(message: string, attributes: Properties = {}): void {
  try {
    if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || !process.env.NEXT_PUBLIC_POSTHOG_HOST) return;
    posthog.logger.info(message, attributes);
  } catch {
    // Log delivery must never break the game.
  }
}

function _isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Array elements take their array's key, so a list of URLs is cut like a single one.
function _redact(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    return _URL_KEY.test(key) ? value.split(/[?#]/, 1)[0] : value.replace(_URL_IN_TEXT, '$1');
  }
  if (Array.isArray(value)) return value.map((item) => _redact(item, key));
  if (_isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, _redact(v, k)]));
  }
  return value;
}

function _stripUrls(props: Properties): Properties {
  return _redact(props, '') as Properties;
}

export function trackGameInit(
  roomCode: string,
  status: PublicGameState['status'] | undefined,
  playerCount: number,
): void {
  try {
    const key = _markerKey(roomCode);
    // game_over can be missed (tab closed, reload onto a finished game), so a stale marker would hide a rematch.
    if (status !== 'active') {
      localStorage.removeItem(key);
      return;
    }
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

// The hook reloads 2 s after a drop and the network may be down, so a send now would be lost.
export function trackSocketDropped(closeCode: number): void {
  try {
    if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || !process.env.NEXT_PUBLIC_POSTHOG_HOST) return;
    localStorage.setItem(_SOCKET_DROPPED_KEY, String(closeCode));
  } catch {
    // Tracking must never break the game.
  }
}

export function reportPendingSocketDrop(): void {
  try {
    const stored = localStorage.getItem(_SOCKET_DROPPED_KEY);
    if (stored === null) return;
    // Removing first means a failing capture cannot resend the drop on every load.
    localStorage.removeItem(_SOCKET_DROPPED_KEY);
    const closeCode = Number(stored);
    if (!Number.isFinite(closeCode)) return;
    _capture('game_socket_dropped', { close_code: closeCode });
  } catch {
    // Tracking must never break the app.
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
