'use client';

/**
 * DeclarationTurnPassPrompt — a banner shown after a correct declaration while
 * the declarant chooses which eligible teammate receives the next turn.
 *
 * Sub-AC 56b: Visually prompt the current turn player (the declarant) to click
 * one of the cyan-highlighted eligible seats.  Other players see a read-only
 * status strip indicating who is making the choice.  Both views clear when the
 * selection is made (i.e. when `postDeclarationHighlight` becomes null after
 * `sendChooseNextTurn` fires or `post_declaration_turn_selected` arrives).
 *
 * ### When it appears
 * Rendered whenever `postDeclarationHighlight` is non-null in the game view.
 * - For the **current turn player** (declarant): full-colour cyan banner with
 *   actionable instruction text and a blinking arrow cue.
 * - For **all other players / spectators**: muted status strip showing who is
 *   choosing.
 *
 * ### When it disappears
 * The parent removes the component when `postDeclarationHighlight` is set to
 * `null`.  That happens in two ways:
 * 1. The player clicks a highlighted seat → `sendChooseNextTurn` is called →
 *    `postDeclarationHighlight` is cleared optimistically.
 * 2. The 30-second post-declaration timer expires → server sends
 *    `post_declaration_turn_selected` → hook clears `postDeclarationHighlight`.
 *
 * ### Accessibility
 * - `role="status"` + `aria-live="polite"` so screen-reader users hear the
 *   announcement without interrupting ongoing narration.
 * - `data-testid="declaration-turn-pass-prompt"` on the container.
 * - `data-testid="turn-pass-prompt-for-me"` when this player is the chooser.
 * - `data-testid="turn-pass-prompt-for-others"` when observing another's choice.
 *
 * @example
 * // Inside game page — render when postDeclarationHighlight is non-null:
 * {postDeclarationHighlight && (
 *   <DeclarationTurnPassPrompt
 *     isMyTurn={isMyTurn}
 *     chooserName={currentTurnPlayer?.displayName ?? null}
 *   />
 * )}
 */

import React from 'react';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface DeclarationTurnPassPromptProps {
  /**
   * `true` when the local player is the current turn player (the declarant who
   * must choose a teammate to pass the turn to).  Drives the two visual variants.
   */
  isMyTurn: boolean;

  /**
   * Display name of the player who is making the choice.
   *
   * - When `isMyTurn` is `false`, the banner reads "X is choosing who gets the
   *   next turn" using this name.
   * - When `isMyTurn` is `true`, this prop is not displayed but may be used for
   *   accessibility labels.
   * - `null` is accepted for transient loading states; the banner falls back to
   *   "Someone is choosing…".
   */
  chooserName: string | null;

  /** Extra Tailwind classes forwarded to the outermost element. */
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * `DeclarationTurnPassPrompt` renders the turn-pass selection banner shown
 * after a correct declaration while the declarant picks a recipient.
 */
const DeclarationTurnPassPrompt: React.FC<DeclarationTurnPassPromptProps> = ({
  isMyTurn,
  chooserName,
  className = '',
}) => {
  // ── My-turn variant (declarant's actionable prompt) ──────────────────────
  if (isMyTurn) {
    return (
      <div
        className={[
          'relative z-10',
          'flex items-center justify-center gap-2',
          'px-4 py-2',
          'bg-cyan-900/70 border-b border-cyan-600/50',
          'text-sm font-medium text-cyan-100',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        role="status"
        aria-live="polite"
        data-testid="declaration-turn-pass-prompt"
        data-variant="for-me"
      >
        {/* Pulsing pointer to draw attention */}
        <span
          className="text-base animate-bounce"
          aria-hidden="true"
          data-testid="turn-pass-prompt-icon"
        >
          👆
        </span>

        {/* Instruction text */}
        <span data-testid="turn-pass-prompt-for-me">
          <strong>You declared!</strong> Click a highlighted teammate to pass your turn.
        </span>

        {/* Cyan indicator dot — matches the seat highlight colour */}
        <span
          className="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse flex-shrink-0"
          aria-hidden="true"
          data-testid="turn-pass-highlight-indicator"
        />
      </div>
    );
  }

  // ── Observer variant (other players' read-only status strip) ─────────────
  const name = chooserName ?? 'Someone';

  return (
    <div
      className={[
        'relative z-10',
        'flex items-center justify-center gap-2',
        'px-4 py-1.5',
        'bg-slate-800/60 border-b border-slate-600/40',
        'text-xs text-slate-400',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="status"
      aria-live="polite"
      data-testid="declaration-turn-pass-prompt"
      data-variant="for-others"
    >
      <span
        className="inline-block w-2 h-2 rounded-full bg-cyan-500/70 animate-pulse flex-shrink-0"
        aria-hidden="true"
      />
      <span data-testid="turn-pass-prompt-for-others">
        <strong className="text-slate-300">{name}</strong> is choosing who gets the next turn…
      </span>
    </div>
  );
};

export default DeclarationTurnPassPrompt;
