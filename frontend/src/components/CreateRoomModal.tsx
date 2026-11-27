'use client';

/**
 * CreateRoomModal
 *
 * Overlay modal for configuring and creating a new private Literature game room.
 *
 * Presented when the host clicks "Private Room" on the home page (after their
 * display name has already been set via GuestNameModal).
 *
 * Form: player count, 6 or 8 (radio cards). Rooms always remove the 7s.
 *
 * The created room data is cached in sessionStorage so the room lobby page can
 * display instantly without an additional API round-trip.
 */

import React, {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createRoom, ApiError } from '@/lib/api';
import { gamePath, roomPath } from '@/lib/appPaths';
import { trackEvent } from '@/lib/analytics';
import { useGuest } from '@/contexts/GuestContext';
import {
  PLAYER_COUNT_OPTIONS,
  type Room,
  type RoomStatus,
} from '@/types/room';

// ── Session-storage helpers ───────────────────────────────────────────────────

/** Cache key for the newly created room so the lobby page can skip its fetch. */
export function getCreatedRoomCacheKey(code: string): string {
  return `literati_created_room_${code.toUpperCase()}`;
}

/** Persist a freshly created room to sessionStorage (tab-scoped). */
export function cacheCreatedRoom(room: Room): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(getCreatedRoomCacheKey(room.code), JSON.stringify(room));
  } catch {
    // sessionStorage unavailable — non-fatal; lobby will fetch via API
  }
}

/** Read and clear the cached room (one-shot consumption). */
export function consumeCreatedRoom(code: string): Room | null {
  if (typeof window === 'undefined') return null;
  const key = getCreatedRoomCacheKey(code);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key);
    return JSON.parse(raw) as Room;
  } catch {
    return null;
  }
}

// ── Props ────────────────────────────────────────────────────────────────────

interface CreateRoomModalProps {
  /** Whether the modal is visible. */
  open: boolean;
  /** The guest's display name — used to obtain a backend bearer token. */
  displayName: string;
  /** Called when the modal should be hidden (cancel or post-success). */
  onClose: () => void;
}

function getExistingRoomPath(existingRoom: {
  code: string;
  status?: RoomStatus;
}): string {
  return existingRoom.status === 'in_progress'
    ? gamePath(existingRoom.code)
    : roomPath(existingRoom.code);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CreateRoomModal({
  open,
  displayName,
  onClose,
}: CreateRoomModalProps) {
  const router = useRouter();
  const { guestSession } = useGuest();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [playerCount, setPlayerCount] = useState<6 | 8>(6);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state whenever modal reopens
  useEffect(() => {
    if (open) {
      setPlayerCount(6);
      setError(null);
      setIsSubmitting(false);
    }
  }, [open]);

  // ── Focus management ───────────────────────────────────────────────────────
  const firstRadioRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // Let animation settle before moving focus
      const t = setTimeout(() => firstRadioRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── Keyboard handling ──────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    },
    [isSubmitting, onClose]
  );

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (isSubmitting) return;

      setError(null);
      setIsSubmitting(true);

      try {
        const { room } = await createRoom(
          { playerCount, cardRemovalVariant: 'remove_7s' },
          displayName,
          undefined,
          guestSession?.sessionId ?? null,
        );
        trackEvent('private_room_created', {
          player_count: room.player_count,
          card_removal_variant: room.card_removal_variant,
        });
        // Cache room data so the lobby page can render without an extra fetch
        cacheCreatedRoom(room);
        onClose();
        router.push(roomPath(room.code));
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 409) {
            // Host already has an active room — route to lobby or game based
            // on the current room status.
            const existing = (err.body as {
              existingRoom?: { code: string; status?: RoomStatus };
            })
              ?.existingRoom;
            if (existing?.code) {
              onClose();
              router.push(getExistingRoomPath(existing));
              return;
            }
            setError('You already have an active room. Rejoin it first.');
          } else {
            setError(err.message);
          }
        } else {
          setError('Could not reach the server. Please try again.');
        }
        setIsSubmitting(false);
      }
    },
    [isSubmitting, playerCount, displayName, guestSession, onClose, router]
  );

  // ── Render guard ───────────────────────────────────────────────────────────
  if (!open) return null;

  return createPortal(
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-room-title"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !isSubmitting && onClose()}
        aria-hidden="true"
      />

      {/* Card */}
      <div
        className="
          relative z-10 w-full max-w-sm
          overflow-y-auto max-h-[calc(100dvh-2rem)]
          bg-gradient-to-b from-emerald-950 to-slate-900
          border border-emerald-700/50
          rounded-2xl shadow-2xl shadow-black/60
          p-6 sm:p-8
          animate-modal-in
        "
        onClick={(e) => e.stopPropagation()}
      >
        {/* Decorative suit symbols */}
        <div
          className="absolute top-3 left-4 text-emerald-700/40 text-2xl select-none"
          aria-hidden="true"
        >
          ♣
        </div>
        <div
          className="absolute top-3 right-4 text-emerald-700/40 text-2xl select-none"
          aria-hidden="true"
        >
          ♦
        </div>

        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-4xl mb-3 select-none" aria-hidden="true">
            🔒
          </div>
          <h2
            id="create-room-title"
            className="text-2xl font-bold text-white tracking-tight"
          >
            Create Private Room
          </h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate>

          {/* ── Player count ──────────────────────────────────────────────── */}
          <fieldset className="mb-5">
            <legend className="block text-sm font-medium text-emerald-200 mb-2">
              Number of Players
            </legend>

            <div className="grid grid-cols-2 gap-3" role="radiogroup">
              {PLAYER_COUNT_OPTIONS.map((count, idx) => {
                const isSelected = playerCount === count;
                return (
                  <label
                    key={count}
                    className={`
                      relative flex flex-col items-center justify-center
                      h-20 rounded-xl border-2 cursor-pointer
                      transition-all duration-150 select-none
                      focus-within:ring-2 focus-within:ring-emerald-400 focus-within:ring-offset-2 focus-within:ring-offset-slate-900
                      ${
                        isSelected
                          ? 'border-emerald-500 bg-emerald-900/60 text-white'
                          : 'border-slate-600 bg-slate-800/40 text-slate-300 hover:border-slate-500 hover:bg-slate-800/60'
                      }
                    `}
                  >
                    <input
                      ref={idx === 0 ? firstRadioRef : undefined}
                      type="radio"
                      name="playerCount"
                      value={count}
                      checked={isSelected}
                      onChange={() =>
                        setPlayerCount(count as 6 | 8)
                      }
                      className="sr-only"
                      aria-label={`${count} players`}
                    />

                    {/* Player icon row */}
                    <div
                      className="flex gap-0.5 mb-1.5"
                      aria-hidden="true"
                    >
                      {Array.from({ length: Math.min(count, 8) }).map(
                        (_, i) => (
                          <span
                            key={i}
                            className={`
                              w-2 h-2 rounded-full
                              ${isSelected ? 'bg-emerald-400' : 'bg-slate-500'}
                            `}
                          />
                        )
                      )}
                    </div>

                    <span className="text-xl font-bold">{count}</span>
                    <span className="text-xs mt-0.5 opacity-70">
                      {count === 6 ? '3v3' : '4v4'}
                    </span>

                    {/* Selected checkmark */}
                    {isSelected && (
                      <span
                        className="absolute top-1.5 right-2 text-emerald-400 text-xs"
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* ── Error message ─────────────────────────────────────────────── */}
          {error && (
            <p
              role="alert"
              className="mb-4 text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2"
            >
              {error}
            </p>
          )}

          {/* ── Actions ────────────────────────────────────────────────────── */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="
                flex-1 py-3 px-4 rounded-xl font-medium text-sm
                border border-slate-600 text-slate-300
                hover:border-slate-500 hover:text-white hover:bg-slate-800/50
                disabled:opacity-40 disabled:cursor-not-allowed
                transition-all duration-150
                focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900
              "
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="
                flex-1 py-3 px-4 rounded-xl font-semibold text-sm
                bg-emerald-600 hover:bg-emerald-500
                disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed
                text-white shadow-lg shadow-emerald-900/40
                transition-all duration-150 active:scale-[0.98]
                focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900
              "
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8z"
                    />
                  </svg>
                  Creating…
                </span>
              ) : (
                'Create Room'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
