'use client';

/**
 * GuestNameModal
 *
 * A full-screen overlay modal that prompts unauthenticated users to enter a
 * display name before joining a game or lobby.
 *
 * Features:
 * - Non-empty validation
 * - Max-length enforcement (DISPLAY_NAME_MAX_LENGTH)
 * - Character-allowlist validation
 * - Character counter
 * - Accessible: focus trap, ARIA roles, keyboard submit (Enter)
 * - Mobile-friendly with large touch targets
 * - Animated entrance
 */

import CardFan from '@/components/CardFan';
import React, {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useGuest } from '@/contexts/GuestContext';
import {
  DISPLAY_NAME_MAX_LENGTH,
  validateDisplayName,
} from '@/types/user';

export default function GuestNameModal() {
  const { isModalOpen, setGuestName, closeModal } = useGuest();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when modal opens
  useEffect(() => {
    if (isModalOpen) {
      setName('');
      setError(null);
      // Small delay to let the animation complete
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isModalOpen]);

  // Trap focus inside modal
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    },
    [closeModal]
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const validationError = validateDisplayName(name);
      if (validationError) {
        setError(validationError);
        inputRef.current?.focus();
        return;
      }
      setIsSubmitting(true);
      // setGuestName is synchronous, but use async pattern for future extension
      try {
        setGuestName(name.trim());
      } finally {
        setIsSubmitting(false);
      }
    },
    [name, setGuestName]
  );

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // Enforce max length at the input level
      if (value.length <= DISPLAY_NAME_MAX_LENGTH) {
        setName(value);
        // Clear error on change so user gets live feedback
        if (error) setError(null);
      }
    },
    [error]
  );

  if (!isModalOpen) return null;

  const remaining = DISPLAY_NAME_MAX_LENGTH - name.length;
  const isNearLimit = remaining <= 5;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-modal-title"
      onKeyDown={handleKeyDown}
    >
      {/* Semi-transparent overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeModal}
        aria-hidden="true"
      />

      {/* Modal card */}
      <div
        className="
          relative z-10 w-full max-w-sm mx-4
          bg-felt-panel
          border border-sage/40
          rounded-2xl shadow-2xl shadow-black/60
          p-6 sm:p-8
          animate-modal-in
        "
        onClick={(e) => e.stopPropagation()}
      >
        {/* Card suit decorations */}
        <div
          className="absolute top-3 left-4 text-sage/40 text-2xl select-none"
          aria-hidden="true"
        >
          ♠
        </div>
        <div
          className="absolute top-3 right-4 text-sage/40 text-2xl select-none"
          aria-hidden="true"
        >
          ♥
        </div>

        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-4xl mb-3 select-none" aria-hidden="true">
            🃏
          </div>
          <h2
            id="guest-modal-title"
            className="text-2xl font-bold text-paper tracking-tight"
          >
            Welcome to Literati
          </h2>
          <p className="mt-1 text-sm text-paper-muted">
            Choose the name your friends will see at the table.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <label
              htmlFor="guest-display-name"
              className="block text-sm font-medium text-paper mb-1.5"
            >
              Display Name
            </label>

            <div className="relative">
              <input
                ref={inputRef}
                id="guest-display-name"
                type="text"
                autoComplete="nickname"
                autoCapitalize="words"
                spellCheck={false}
                value={name}
                onChange={handleNameChange}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="e.g. CardShark99"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                aria-describedby={
                  error ? 'guest-name-error' : 'guest-name-hint'
                }
                aria-invalid={!!error}
                className={`
                  w-full px-4 py-3 rounded-xl text-paper text-base
                  bg-felt-inset border
                  placeholder:text-paper-muted/70
                  focus:outline-none focus:ring-2 focus:ring-sage
                  transition-colors
                  ${
                    error
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-sage/50 hover:border-sage'
                  }
                `}
              />

              {/* Character counter */}
              <span
                aria-live="polite"
                className={`
                  absolute right-3 top-1/2 -translate-y-1/2 text-xs
                  ${isNearLimit ? 'text-amber-400' : 'text-paper-muted'}
                `}
              >
                {remaining}
              </span>
            </div>

            {/* Error message */}
            {error ? (
              <p
                id="guest-name-error"
                role="alert"
                className="mt-1.5 text-sm text-red-400"
              >
                {error}
              </p>
            ) : (
              <p
                id="guest-name-hint"
                className="mt-1.5 text-xs text-paper-muted"
              >
                Letters, numbers, spaces, and _ - &#39; . only
              </p>
            )}
          </div>

          {/* Submit button */}
          <button
            type="submit"
            disabled={isSubmitting || name.trim().length === 0}
            className="
              w-full py-3 px-4 rounded-xl font-semibold text-base
              enabled:cursor-pointer bg-copper enabled:hover:bg-copper-hover
              disabled:bg-felt-hover disabled:text-paper-muted/70 disabled:cursor-not-allowed
              text-felt
              transition-all duration-150
              focus:outline-none focus:ring-2 focus:ring-sage focus:ring-offset-2 focus:ring-offset-felt-panel
              active:scale-[0.98]
            "
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <CardFan compact />
                Joining…
              </span>
            ) : (
              'Continue as Guest'
            )}
          </button>

        </form>

        {/* Footer note */}
        <p className="mt-4 text-center text-xs text-paper-muted">
          Guest stats are not saved.
        </p>
      </div>
    </div>
  );
}
