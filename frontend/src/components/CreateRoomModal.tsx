'use client';

/**
 * CreateRoomModal
 *
 * Overlay modal for configuring and creating a new private Literature game room.
 *
 * Presented when the host clicks "Private Room" on the home page (after their
 * display name has already been set via GuestNameModal).
 *
 * Form fields:
 *  1. Player count   — 6 or 8 players (radio cards)
 *  2. Card variant   — remove_2s | remove_7s | remove_8s (radio list)
 *
 * On success the modal transitions to a "Room Created!" confirmation phase that
 * immediately displays the invite code, invite link, and spectator link.
 * The host then clicks "Enter Room →" to navigate to the room lobby.
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
import { useRouter } from 'next/navigation';
import { createRoom, ApiError } from '@/lib/api';
import {
  PLAYER_COUNT_OPTIONS,
  VARIANT_OPTIONS,
  type CardRemovalVariant,
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
    ? `/game/${existingRoom.code}`
    : `/room/${existingRoom.code}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CreateRoomModal({
  open,
  displayName,
  onClose,
}: CreateRoomModalProps) {
  const router = useRouter();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [playerCount, setPlayerCount] = useState<6 | 8>(6);
  const [variant, setVariant] = useState<CardRemovalVariant>('remove_7s');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Success phase state ────────────────────────────────────────────────────
  /** Populated after the room-created API response is received. */
  const [createdRoom, setCreatedRoom] = useState<Room | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [copiedSpectator, setCopiedSpectator] = useState(false);

  // Reset state whenever modal reopens
  useEffect(() => {
    if (open) {
      setPlayerCount(6);
      setVariant('remove_7s');
      setError(null);
      setIsSubmitting(false);
      setCreatedRoom(null);
      setCopiedInvite(false);
      setCopiedSpectator(false);
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
        const { room } = await createRoom({ playerCount, cardRemovalVariant: variant }, displayName);
        // Cache room data so the lobby page can render without an extra fetch
        cacheCreatedRoom(room);
        // Show the success confirmation panel immediately
        setCreatedRoom(room);
        setIsSubmitting(false);
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
    [isSubmitting, playerCount, variant, displayName, onClose, router]
  );

  // ── Enter room (from success phase) ────────────────────────────────────────
  const handleEnterRoom = useCallback(() => {
    if (!createdRoom) return;
    onClose();
    router.push(`/room/${createdRoom.code}`);
  }, [createdRoom, onClose, router]);

  // ── Copy helpers ───────────────────────────────────────────────────────────
  const handleCopyInvite = useCallback(() => {
    if (typeof window === 'undefined' || !createdRoom) return;
    const url = `${window.location.origin}/room/${createdRoom.code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2000);
    });
  }, [createdRoom]);

  const handleCopySpectator = useCallback(() => {
    if (typeof window === 'undefined' || !createdRoom) return;
    const url = `${window.location.origin}/room/${createdRoom.code}?spectate=1`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedSpectator(true);
      setTimeout(() => setCopiedSpectator(false), 2000);
    });
  }, [createdRoom]);

  // ── Render guard ───────────────────────────────────────────────────────────
  if (!open) return null;

  // ── Success confirmation URLs (computed client-side) ──────────────────────
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const inviteUrl = createdRoom ? `${origin}/room/${createdRoom.code}` : '';
  const spectatorUrl = createdRoom
    ? `${origin}/room/${createdRoom.code}?spectate=1`
    : '';

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-room-title"
      onKeyDown={handleKeyDown}
    >
      {/* Overlay — only close when in form phase (not success) */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !isSubmitting && !createdRoom && onClose()}
        aria-hidden="true"
      />

      {/* Card */}
      <div
        className="
          relative z-10 w-full max-w-sm
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

        {/* ─────────────────────── SUCCESS PHASE ─────────────────────────── */}
        {createdRoom ? (
          <div data-testid="room-created-confirmation">
            {/* Success header */}
            <div className="text-center mb-6">
              <div className="text-4xl mb-3 select-none" aria-hidden="true">
                🎉
              </div>
              <h2
                id="create-room-title"
                className="text-2xl font-bold text-white tracking-tight"
              >
                Room Created!
              </h2>
              <p className="mt-1 text-sm text-emerald-300/80">
                Share the code or links below with your friends
              </p>
            </div>

            {/* Room code — large, select-all */}
            <div className="text-center mb-5">
              <p className="text-xs text-slate-500 uppercase tracking-widest mb-1">
                Room Code
              </p>
              <div
                className="text-5xl font-black font-mono tracking-[0.2em] text-white select-all"
                aria-label={`Room code: ${createdRoom.code}`}
                data-testid="room-code-display"
              >
                {createdRoom.code}
              </div>
            </div>

            {/* Invite link row */}
            <div className="mb-3">
              <p className="text-xs text-emerald-300/70 font-medium mb-1.5 uppercase tracking-widest">
                Invite Link
              </p>
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-300 truncate text-left"
                  data-testid="invite-url-display"
                >
                  {inviteUrl}
                </div>
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  aria-label="Copy invite link"
                  data-testid="copy-invite-btn"
                  className="
                    px-3 py-2 rounded-xl text-xs font-semibold shrink-0
                    bg-emerald-700 hover:bg-emerald-600 text-white
                    transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
                  "
                >
                  {copiedInvite ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {/* Spectator link row */}
            <div className="mb-6">
              <p className="text-xs text-slate-400/70 font-medium mb-1.5 uppercase tracking-widest">
                Spectator Link
              </p>
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 bg-slate-800 border border-slate-600/60 rounded-xl px-3 py-2 text-xs font-mono text-slate-400 truncate text-left"
                  data-testid="spectator-url-display"
                >
                  {spectatorUrl}
                </div>
                <button
                  type="button"
                  onClick={handleCopySpectator}
                  aria-label="Copy spectator link"
                  data-testid="copy-spectator-btn"
                  className="
                    px-3 py-2 rounded-xl text-xs font-semibold shrink-0
                    bg-slate-600 hover:bg-slate-500 text-white
                    transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400
                  "
                >
                  {copiedSpectator ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {/* Enter Room button */}
            <button
              type="button"
              onClick={handleEnterRoom}
              data-testid="enter-room-btn"
              className="
                w-full py-3 px-4 rounded-xl font-semibold text-sm
                bg-emerald-600 hover:bg-emerald-500 text-white
                shadow-lg shadow-emerald-900/40
                transition-all duration-150 active:scale-[0.98]
                focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900
              "
            >
              Enter Room →
            </button>
          </div>
        ) : (
          <>
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
          <p className="mt-1 text-sm text-emerald-300/80">
            Configure your game and share the code with friends
          </p>
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

          {/* ── Card removal variant ───────────────────────────────────────── */}
          <fieldset className="mb-5">
            <legend className="block text-sm font-medium text-emerald-200 mb-2">
              Card Removal Variant
            </legend>

            <div className="flex flex-col gap-2" role="radiogroup">
              {VARIANT_OPTIONS.map((opt) => {
                const isSelected = variant === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={`
                      flex items-start gap-3 p-3 rounded-xl border cursor-pointer
                      transition-all duration-150 select-none
                      focus-within:ring-2 focus-within:ring-emerald-400 focus-within:ring-offset-2 focus-within:ring-offset-slate-900
                      ${
                        isSelected
                          ? 'border-emerald-500 bg-emerald-900/40'
                          : 'border-slate-600 bg-slate-800/30 hover:border-slate-500 hover:bg-slate-800/50'
                      }
                    `}
                  >
                    <input
                      type="radio"
                      name="cardRemovalVariant"
                      value={opt.value}
                      checked={isSelected}
                      onChange={() => setVariant(opt.value)}
                      className="mt-0.5 accent-emerald-500 w-4 h-4 flex-shrink-0"
                      aria-describedby={`variant-desc-${opt.value}`}
                    />
                    <span>
                      <span
                        className={`font-semibold text-sm ${
                          isSelected ? 'text-emerald-300' : 'text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </span>
                      <span
                        id={`variant-desc-${opt.value}`}
                        className="block text-xs text-slate-400 mt-0.5"
                      >
                        {opt.description}
                      </span>
                    </span>
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
          </>
        )}
      </div>
    </div>
  );
}
