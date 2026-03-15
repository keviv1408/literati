/**
 * @jest-environment jsdom
 *
 * Tests for RematchVotePanel component.
 *
 * Coverage:
 *   Rendering states:
 *     1. Shows "Waiting for rematch vote…" when both rematchVote and rematchDeclined are null
 *     2. Shows decline panel with reason "Vote timed out" when rematchDeclined.reason is 'timeout'
 *     3. Shows decline panel with reason "Majority voted no" when rematchDeclined.reason is 'majority_no'
 *     4. Renders the vote panel when rematchVote is provided
 *     5. Shows correct tally text (e.g. "2 / 6 voted yes · need 4")
 *     6. Renders Yes and No buttons for a human local player who hasn't voted
 *     7. Does NOT render vote buttons for bots (myPlayerId is a bot in playerVotes)
 *     8. Renders player vote list with all players
 *     9. Shows ✔ Yes for players who voted yes
 *    10. Shows ✘ No for players who voted no
 *    11. Shows … for players who haven't voted
 *    12. Shows countdown timer element
 *   Interaction:
 *    13. Clicking Yes button calls onVote(true)
 *    14. Clicking No button calls onVote(false)
 *    15. Buttons are disabled after voting (pressing Yes disables both buttons)
 *    16. aria-pressed is set correctly after voting
 *    17. Server-side pre-cast vote disables buttons (myCurrentVote not null)
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RematchVotePanel from '@/components/RematchVotePanel';
import type { RematchVoteUpdatePayload, RematchDeclinedPayload } from '@/types/game';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makePlayerVotes(
  overrides?: Partial<{ h1Vote: boolean | null; h2Vote: boolean | null; b1Vote: boolean | null }>
) {
  const { h1Vote = null, h2Vote = null, b1Vote = true } = overrides ?? {};
  return [
    { playerId: 'h1', displayName: 'Alice', isBot: false, vote: h1Vote },
    { playerId: 'h2', displayName: 'Bob',   isBot: false, vote: h2Vote },
    { playerId: 'h3', displayName: 'Carol', isBot: false, vote: null   },
    { playerId: 'h4', displayName: 'Dave',  isBot: false, vote: null   },
    { playerId: 'b1', displayName: 'Bot1',  isBot: true,  vote: b1Vote },
    { playerId: 'b2', displayName: 'Bot2',  isBot: true,  vote: true   },
  ];
}

function makeVotePayload(
  overrides?: Partial<RematchVoteUpdatePayload>
): RematchVoteUpdatePayload {
  const playerVotes = makePlayerVotes();
  return {
    type:             'rematch_vote_update',
    yesCount:         2,    // 2 bot yes votes
    noCount:          0,
    totalCount:       6,
    humanCount:       4,
    majority:         4,
    majorityReached:  false,
    majorityDeclined: false,
    votes:            { b1: true, b2: true },
    playerVotes,
    ...overrides,
  };
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RematchVotePanel rendering states', () => {
  test('1. shows "Waiting for rematch vote…" when both props are null', () => {
    render(
      <RematchVotePanel
        rematchVote={null}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByText(/waiting for rematch vote/i)).toBeDefined();
  });

  test('2. shows decline panel with "Vote timed out" reason', () => {
    const declined: RematchDeclinedPayload = { type: 'rematch_declined', reason: 'timeout' };
    render(
      <RematchVotePanel
        rematchVote={null}
        rematchDeclined={declined}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByTestId('rematch-declined-panel')).toBeDefined();
    expect(screen.getByText(/vote timed out/i)).toBeDefined();
  });

  test('3. shows decline panel with "Majority voted no" reason', () => {
    const declined: RematchDeclinedPayload = { type: 'rematch_declined', reason: 'majority_no' };
    render(
      <RematchVotePanel
        rematchVote={null}
        rematchDeclined={declined}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByText(/majority voted no/i)).toBeDefined();
  });

  test('4. renders the vote panel when rematchVote is provided', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByTestId('rematch-vote-panel')).toBeDefined();
  });

  test('5. shows correct tally text', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload({ yesCount: 2, totalCount: 6, majority: 4 })}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByTestId('rematch-tally').textContent).toMatch(/2 \/ 6 voted yes/);
    expect(screen.getByTestId('rematch-tally').textContent).toMatch(/need 4/);
  });

  test('6. renders Yes and No buttons for human local player who has not voted', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByTestId('rematch-yes-btn')).toBeDefined();
    expect(screen.getByTestId('rematch-no-btn')).toBeDefined();
  });

  test('7. does NOT render vote buttons when myPlayerId is a bot', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="b1"
        onVote={noop}
      />
    );
    expect(screen.queryByTestId('rematch-vote-buttons')).toBeNull();
  });

  test('8. renders player vote list with all players', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    expect(screen.getByTestId('rematch-player-votes')).toBeDefined();
    // Alice, Bob, Carol, Dave, Bot1, Bot2
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('Bob')).toBeDefined();
  });

  test('9. shows ✔ Yes for players who voted yes', () => {
    const playerVotes = makePlayerVotes({ h1Vote: true });
    const votes: Record<string, boolean> = { h1: true, b1: true, b2: true };
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload({ playerVotes, votes, yesCount: 3 })}
        rematchDeclined={null}
        myPlayerId="h2"
        onVote={noop}
      />
    );
    const h1Row = screen.getByTestId('rematch-player-vote-h1');
    expect(h1Row.textContent).toContain('✔ Yes');
  });

  test('10. shows ✘ No for players who voted no', () => {
    const playerVotes = makePlayerVotes({ h2Vote: false });
    const votes: Record<string, boolean> = { h2: false, b1: true, b2: true };
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload({ playerVotes, votes, noCount: 1 })}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    const h2Row = screen.getByTestId('rematch-player-vote-h2');
    expect(h2Row.textContent).toContain('✘ No');
  });

  test('11. shows … for players who have not voted', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    // h3 and h4 haven't voted
    const h3Row = screen.getByTestId('rematch-player-vote-h3');
    expect(h3Row.textContent).toContain('…');
  });

  test('12. renders countdown timer element', () => {
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
        voteTimeoutMs={60000}
        voteStartedAt={Date.now()}
      />
    );
    expect(screen.getByTestId('rematch-countdown')).toBeDefined();
  });
});

describe('RematchVotePanel interactions', () => {
  test('13. clicking Yes button calls onVote(true)', () => {
    const onVote = jest.fn();
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={onVote}
      />
    );
    fireEvent.click(screen.getByTestId('rematch-yes-btn'));
    expect(onVote).toHaveBeenCalledWith(true);
  });

  test('14. clicking No button calls onVote(false)', () => {
    const onVote = jest.fn();
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={onVote}
      />
    );
    fireEvent.click(screen.getByTestId('rematch-no-btn'));
    expect(onVote).toHaveBeenCalledWith(false);
  });

  test('15. buttons are disabled after voting (clicking Yes disables both)', () => {
    const onVote = jest.fn();
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={onVote}
      />
    );
    fireEvent.click(screen.getByTestId('rematch-yes-btn'));
    expect((screen.getByTestId('rematch-yes-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('rematch-no-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  test('16. aria-pressed is set correctly after voting yes', () => {
    const onVote = jest.fn();
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload()}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={onVote}
      />
    );
    fireEvent.click(screen.getByTestId('rematch-yes-btn'));
    expect(screen.getByTestId('rematch-yes-btn').getAttribute('aria-pressed')).toBe('true');
  });

  test('17. server-side pre-cast vote disables buttons', () => {
    // h1 already voted yes (from server snapshot)
    const playerVotes = makePlayerVotes({ h1Vote: true });
    const votes: Record<string, boolean> = { h1: true, b1: true, b2: true };
    render(
      <RematchVotePanel
        rematchVote={makeVotePayload({ playerVotes, votes, yesCount: 3 })}
        rematchDeclined={null}
        myPlayerId="h1"
        onVote={noop}
      />
    );
    // Buttons should be disabled since h1 already has a vote in playerVotes
    expect((screen.getByTestId('rematch-yes-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('rematch-no-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});
