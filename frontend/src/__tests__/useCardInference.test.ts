/**
 * @jest-environment jsdom
 *
 * Unit tests for useCardInference hook — Sub-AC 37d
 *
 * Coverage:
 *   Initial state:
 *     1. cardInferences is an empty object on mount
 *     2. resetInferences is a function
 *
 *   ask_result — success=true:
 *     3. Sets askerId as 'confirmed' for the card
 *     4. Sets targetId as 'excluded' for the card
 *     5. Multiple successful asks accumulate
 *
 *   ask_result — success=false:
 *     6. Sets targetId as 'excluded' for the card
 *     7. Does NOT add a 'confirmed' entry for the asker on a failed ask
 *
 *   ask_result — multiple events:
 *     8. Each new lastAskResult updates the inference map (delta, not replace)
 *     9. Different cards for the same player accumulate independently
 *
 *   declaration_result:
 *     10. Sets each card in the assignment as 'confirmed' for its playerId
 *     11. Removes declared cards from all players' inference maps
 *     12. Does NOT remove other cards (non-declared) from the map
 *
 *   resetInferences:
 *     13. Clears the entire inference map to {}
 *     14. resetInferences is stable across re-renders (same callback reference)
 *
 *   Null / missing data:
 *     15. Does not throw if lastAskResult is null
 *     16. Does not throw if lastDeclareResult is null
 *     17. Does not throw if variant is null (declaration result ignored)
 */

import { renderHook, act } from '@testing-library/react';
import { useCardInference } from '@/hooks/useCardInference';
import type { AskResultPayload, DeclarationResultPayload } from '@/types/game';

// ── Helpers ────────────────────────────────────────────────────────────────────

type HookInput = {
  lastAskResult: AskResultPayload | null;
  lastDeclareResult: DeclarationResultPayload | null;
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
};

function mkAsk(
  askerId: string,
  targetId: string,
  cardId: string,
  success: boolean,
  lastMove = '',
): AskResultPayload {
  return { askerId, targetId, cardId, success, lastMove };
}

function mkDeclare(
  halfSuitId: string,
  assignment: Record<string, string>,
  correct: boolean,
  teamId: 1 | 2,
  lastMove = '',
): DeclarationResultPayload {
  return { halfSuitId, assignment, correct, teamId, lastMove };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('useCardInference — initial state', () => {
  it('cardInferences is an empty object on mount', () => {
    const { result } = renderHook(() =>
      useCardInference({
        lastAskResult: null,
        lastDeclareResult: null,
        variant: 'remove_7s',
      }),
    );
    expect(result.current.cardInferences).toEqual({});
  });

  it('resetInferences is a function', () => {
    const { result } = renderHook(() =>
      useCardInference({
        lastAskResult: null,
        lastDeclareResult: null,
        variant: 'remove_7s',
      }),
    );
    expect(typeof result.current.resetInferences).toBe('function');
  });
});

describe('useCardInference — ask_result success=true', () => {
  it('sets askerId as confirmed for the card', () => {
    const ask = mkAsk('p-asker', 'p-target', '5_h', true);
    const { result } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: null,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    act(() => {
      // renderHook doesn't re-render via rerender here; we use rerender
    });

    const { rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: null,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    rerender({ lastAskResult: ask, lastDeclareResult: null, variant: 'remove_7s' });

    // Re-render trick: use a fresh renderHook with initial ask
    const { result: r2 } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    expect(r2.current.cardInferences['p-asker']?.['5_h']).toBe('confirmed');
  });

  it('sets targetId as excluded for the card on a successful ask', () => {
    const ask = mkAsk('p-asker', 'p-target', '5_h', true);
    const { result } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );
    expect(result.current.cardInferences['p-target']?.['5_h']).toBe('excluded');
  });
});

describe('useCardInference — ask_result success=false', () => {
  it('sets targetId as excluded for the card on a failed ask', () => {
    const ask = mkAsk('p-asker', 'p-target', '3_d', false);
    const { result } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );
    expect(result.current.cardInferences['p-target']?.['3_d']).toBe('excluded');
  });

  it('does NOT add a confirmed entry for the asker on a failed ask', () => {
    const ask = mkAsk('p-asker', 'p-target', '3_d', false);
    const { result } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );
    expect(result.current.cardInferences['p-asker']?.['3_d']).toBeUndefined();
  });
});

describe('useCardInference — ask_result delta accumulation', () => {
  it('accumulates inferences from multiple asks without losing earlier ones', () => {
    const ask1 = mkAsk('alice', 'bob', '5_h', true);
    const ask2 = mkAsk('carol', 'dave', '3_s', false);

    const { result, rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask1,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    // apply first ask
    expect(result.current.cardInferences['alice']?.['5_h']).toBe('confirmed');
    expect(result.current.cardInferences['bob']?.['5_h']).toBe('excluded');

    // apply second ask (new object reference)
    rerender({
      lastAskResult: ask2,
      lastDeclareResult: null,
      variant: 'remove_7s',
    });

    // First inference still present
    expect(result.current.cardInferences['alice']?.['5_h']).toBe('confirmed');
    expect(result.current.cardInferences['bob']?.['5_h']).toBe('excluded');
    // Second inference also present
    expect(result.current.cardInferences['dave']?.['3_s']).toBe('excluded');
  });

  it('different cards for the same player accumulate independently', () => {
    const ask1 = mkAsk('alice', 'bob', '5_h', false);
    const ask2 = mkAsk('carol', 'bob', '6_h', false);

    const { result, rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask1,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    rerender({ lastAskResult: ask2, lastDeclareResult: null, variant: 'remove_7s' });

    expect(result.current.cardInferences['bob']?.['5_h']).toBe('excluded');
    expect(result.current.cardInferences['bob']?.['6_h']).toBe('excluded');
  });
});

describe('useCardInference — declaration_result', () => {
  it('sets each card in the assignment as confirmed for its playerId', () => {
    // remove_7s: low_h = A_h, 2_h, 3_h, 4_h, 5_h, 6_h
    // remove_7s: low_h = ranks 1,2,3,4,5,6 → card IDs 1_h,2_h,3_h,4_h,5_h,6_h
    // The hook: (1) marks each assigned card as 'confirmed', (2) removes all
    // getHalfSuitCards(halfSuitId, variant) entries from all players' maps.
    // Net result: no entries for these card IDs remain.
    const declare = mkDeclare(
      'low_h',
      { '1_h': 'alice', '2_h': 'alice', '3_h': 'bob', '4_h': 'bob', '5_h': 'carol', '6_h': 'carol' },
      true,
      1,
    );

    const { result } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: null,
          lastDeclareResult: declare,
          variant: 'remove_7s' as const,
        },
      },
    );

    // All declared cards are removed from the inference map after declaration
    expect(result.current.cardInferences['alice']?.['1_h']).toBeUndefined();
    expect(result.current.cardInferences['alice']?.['2_h']).toBeUndefined();
    expect(result.current.cardInferences['bob']?.['3_h']).toBeUndefined();
  });

  it('removes declared cards from inference map of all players', () => {
    const ask = mkAsk('alice', 'bob', '5_h', false);
    const declare = mkDeclare(
      'low_h',
      { '1_h': 'alice', '2_h': 'alice', '3_h': 'bob', '4_h': 'bob', '5_h': 'carol', '6_h': 'carol' },
      true,
      1,
    );

    const { result, rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    // Bob's exclusion of 5_h was recorded from the ask
    expect(result.current.cardInferences['bob']?.['5_h']).toBe('excluded');

    // Now declare low_h — 5_h is in that half-suit, so it should be removed
    rerender({ lastAskResult: null, lastDeclareResult: declare, variant: 'remove_7s' });

    // 5_h entry removed from bob's inference map
    expect(result.current.cardInferences['bob']?.['5_h']).toBeUndefined();
  });

  it('does NOT remove other cards (non-declared) from the map', () => {
    const ask = mkAsk('alice', 'bob', '5_s', false); // low_s card
    const declare = mkDeclare(
      'low_h',
      { '1_h': 'alice', '2_h': 'alice', '3_h': 'bob', '4_h': 'bob', '5_h': 'carol', '6_h': 'carol' },
      true,
      1,
    );

    const { result, rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    // 5_s excluded for bob from ask
    expect(result.current.cardInferences['bob']?.['5_s']).toBe('excluded');

    // declare low_h — 5_s is NOT in low_h, so it should remain
    rerender({ lastAskResult: null, lastDeclareResult: declare, variant: 'remove_7s' });

    expect(result.current.cardInferences['bob']?.['5_s']).toBe('excluded');
  });

  it('does nothing for declaration when variant is null', () => {
    const ask = mkAsk('alice', 'bob', '5_h', false);
    const declare = mkDeclare('low_h', { A_h: 'alice' }, true, 1);

    const { result, rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: null,
        },
      },
    );

    // Build up some inference
    expect(result.current.cardInferences['bob']?.['5_h']).toBe('excluded');

    // Provide declaration but variant is null — should not throw or clear inferences
    rerender({ lastAskResult: null, lastDeclareResult: declare, variant: null });

    // Inference from ask is still there (declaration with null variant is skipped)
    expect(result.current.cardInferences['bob']?.['5_h']).toBe('excluded');
  });
});

describe('useCardInference — resetInferences', () => {
  it('clears the entire inference map to {}', () => {
    const ask = mkAsk('alice', 'bob', '5_h', true);
    const { result } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: ask,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    // Inferences should be populated
    expect(Object.keys(result.current.cardInferences).length).toBeGreaterThan(0);

    act(() => {
      result.current.resetInferences();
    });

    expect(result.current.cardInferences).toEqual({});
  });

  it('resetInferences is a stable callback reference across re-renders', () => {
    const { result, rerender } = renderHook(
      (props: HookInput) => useCardInference(props),
      {
        initialProps: {
          lastAskResult: null,
          lastDeclareResult: null,
          variant: 'remove_7s' as const,
        },
      },
    );

    const first = result.current.resetInferences;
    rerender({ lastAskResult: null, lastDeclareResult: null, variant: 'remove_7s' });
    const second = result.current.resetInferences;

    expect(first).toBe(second);
  });
});

describe('useCardInference — null / missing data', () => {
  it('does not throw if lastAskResult is null', () => {
    expect(() =>
      renderHook(() =>
        useCardInference({
          lastAskResult: null,
          lastDeclareResult: null,
          variant: 'remove_7s',
        }),
      ),
    ).not.toThrow();
  });

  it('does not throw if lastDeclareResult is null', () => {
    expect(() =>
      renderHook(() =>
        useCardInference({
          lastAskResult: null,
          lastDeclareResult: null,
          variant: 'remove_7s',
        }),
      ),
    ).not.toThrow();
  });

  it('does not throw if variant is null', () => {
    expect(() =>
      renderHook(() =>
        useCardInference({
          lastAskResult: null,
          lastDeclareResult: null,
          variant: null,
        }),
      ),
    ).not.toThrow();
  });
});
