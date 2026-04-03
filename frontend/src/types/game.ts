/**
 * Game type definitions for the Literati Literature card game.
 *
 * Cards are represented as "{rank}_{suit}" strings:
 * rank: 1=Ace, 2-9, 10, 11=Jack, 12=Queen, 13=King
 * suit: s=Spades, h=Hearts, d=Diamonds, c=Clubs
 *
 * Half-suit IDs: "{low|high}_{s|h|d|c}" e.g. "low_s", "high_d"
 */

export type CardSuit = 's' | 'h' | 'd' | 'c';

export type CardRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/** Card ID string e.g. "1_s", "13_d", "10_c" */
export type CardId = string;

/** Half-suit ID string e.g. "low_s", "high_d" */
export type HalfSuitId = string;

export interface ParsedCard {
  rank: CardRank;
  suit: CardSuit;
  id: CardId;
}

/** Player info as broadcast by the game WebSocket. */
export interface GamePlayer {
  playerId: string;
  displayName: string;
  avatarId: string | null;
  teamId: 1 | 2;
  seatIndex: number;
  cardCount: number;
  isBot: boolean;
  isGuest: boolean;
  isCurrentTurn: boolean;
  /**
   * true when this player's hand was emptied by a declaration
   * and they can no longer ask, be asked, or declare.
   */
  isEliminated?: boolean;
}

/** A declared half-suit with which team won it. */
export interface DeclaredSuit {
  halfSuitId: HalfSuitId;
  teamId: 1 | 2;
  declaredBy: string;
}

/** Public game state broadcast to all players. */
export interface PublicGameState {
  status: 'active' | 'completed' | 'abandoned';
  currentTurnPlayerId: string | null;
  scores: { team1: number; team2: number };
  lastMove: string | null;
  winner: 1 | 2 | null;
  tiebreakerWinner: 1 | 2 | null;
  declaredSuits: DeclaredSuit[];
}

/** Full game init payload sent to each player on connection. */
export interface GameInitPayload {
  type: 'game_init';
  roomCode: string;
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  playerCount: 6 | 8;
  myPlayerId: string;
  myHand: CardId[];
  players: GamePlayer[];
  gameState: PublicGameState;
}

/** Full hand map sent only to God-mode spectators. */
export type SpectatorHands = Record<string, CardId[]>;

/** Formatted move-log entry sent only to God-mode spectators. */
export interface SpectatorMoveEntry {
  type: string;
  ts: number;
  message: string;
}

/** Read-only init payload sent to spectator connections on connect/rematch. */
export interface SpectatorInitPayload {
  type: 'spectator_init';
  roomCode: string;
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s';
  playerCount: 6 | 8;
  players: GamePlayer[];
  hands: SpectatorHands;
  moveHistory: SpectatorMoveEntry[];
  gameState: PublicGameState;
}

/** Result of an ask-card action. */
export interface AskResultPayload {
  type: 'ask_result';
  askerId: string;
  targetId: string;
  cardId: CardId;
  batchCardIds?: CardId[];
  success: boolean;
  newTurnPlayerId: string;
  lastMove: string;
}

/** Result of a declaration. */
export interface DeclarationResultPayload {
  type: 'declaration_result';
  declarerId: string;
  halfSuitId: HalfSuitId;
  correct: boolean;
  /** Present and true only when the declaration was forced-failed due to timer expiry. */
  timedOut?: boolean;
  winningTeam: 1 | 2;
  newTurnPlayerId: string;
  assignment: Record<CardId, string>; // cardId → playerId
  lastMove: string;
  /**
   * IDs of all non-eliminated players who still have at least one
   * card remaining after the declaration, ordered by seatIndex.
   *
   * Includes the declarant if they still hold cards after the 6 half-suit
   * cards are removed. Clients use this to update their game state immediately
   * on receiving the message — before the subsequent `game_players` broadcast
   * arrives — so the table layout can reflect who is still an active participant.
   *
   * Always present for both correct and incorrect declarations (including
   * forced-failed timer-expiry declarations). Optional here for backward
   * compatibility with legacy client snapshots that pre-date
   */
  eligibleNextTurnPlayerIds?: string[];
}

/**
 * Diff entry for a single incorrectly-assigned card in a failed declaration.
 * Included in `DeclarationFailedPayload.wrongAssignmentDiffs`.
 */
export interface WrongAssignmentDiff {
  /** Card ID that was assigned incorrectly. */
  card: CardId;
  /** Player ID the declarant claimed held this card. */
  claimedPlayerId: string;
  /** Player ID who actually holds this card (null if no one held it, which should not happen). */
  actualPlayerId: string | null;
}

/**
 * Broadcast to ALL clients immediately after a failed declaration.
 *
 * Carries the detailed per-card diff so clients can show a
 * FailedDeclarationReveal overlay that highlights which assignments were
 * wrong, crossing out the claimed holder and showing the actual holder.
 *
 * Sent only when `correct === false`; correct declarations have no diff to show.
 *
 * Shape mirrors the gameSocketServer.js broadcast at handleDeclare lines ~1665–1674.
 */
export interface DeclarationFailedPayload {
  type: 'declarationFailed';
  /** The player who made the (incorrect) declaration. */
  declarerId: string;
  /** Which half-suit was declared. */
  halfSuitId: HalfSuitId;
  /** Team that scored the point (opposite of declarant's team). */
  winningTeam: 1 | 2;
  /**
   * The claimed assignment: cardId → claimed playerId.
   * This is what the declarant said — some entries will be wrong.
   */
  assignment: Record<CardId, string>;
  /**
   * Only the cards that were assigned incorrectly.
   * Subset of the 6 half-suit cards where claimedPlayerId ≠ actualPlayerId.
   */
  wrongAssignmentDiffs: WrongAssignmentDiff[];
  /**
   * The ground-truth holders for all 6 cards in the half-suit.
   * cardId → actual playerId (captured before cards were removed from hands).
   */
  actualHolders: Record<CardId, string>;
  lastMove: string;
}

/** Game over payload. */
export interface GameOverPayload {
  type: 'game_over';
  winner: 1 | 2 | null;
  tiebreakerWinner: 1 | 2 | null;
  scores: { team1: number; team2: number };
}

/** Per-player post-game summary row returned by GET /api/stats/game-summary/:roomCode. */
export interface GameSummaryPlayer {
  playerId: string;
  displayName: string | null;
  avatarId: string | null;
  teamId: 1 | 2;
  isBot: boolean;
  isGuest: boolean;
  declarationAttempts: number;
  declarationSuccesses: number;
  declarationFailures: number;
  askAttempts: number;
  askSuccesses: number;
  askFailures: number;
  repeatedAskAttempts: number;
  cardsWonFromOpponents: number;
  mostTargetedOpponentId: string | null;
  mostTargetedOpponentAskCount: number;
  averageMoveTimeMs: number | null;
}

/** Completed-game summary payload returned by the stats API. */
export interface GameSummaryResponse {
  roomCode: string;
  winner: 1 | 2 | null;
  tiebreakerWinner: 1 | 2 | null;
  scores: { team1: number; team2: number };
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
  declaredSuits: DeclaredSuit[];
  playerSummaries: GameSummaryPlayer[];
  mvpPlayerId: string | null;
}

/** Per-player rematch vote visibility record. */
export interface PlayerVoteRecord {
  playerId: string;
  displayName: string;
  isBot: boolean;
  vote: boolean | null; // null = not yet voted
}

/** Rematch vote tally broadcast after every vote cast (including bot auto-votes). */
export interface RematchVoteUpdatePayload {
  type: 'rematch_vote_update';
  yesCount: number;
  noCount: number;
  totalCount: number;
  humanCount: number;
  majority: number;
  majorityReached: boolean;
  majorityDeclined: boolean;
  votes: Record<string, boolean>;
  playerVotes: PlayerVoteRecord[];
}

/**
 * Per-player team entry included in the rematch_start broadcast so the
 * lobby can pre-populate the correct team assignments before players reconnect.
 */
export interface RematchPreviousTeamEntry {
  playerId: string;
  teamId: 1 | 2;
  seatIndex: number;
  isBot: boolean;
}

/**
 * Broadcast when a majority of players (including bots) voted yes.
 *
 * Includes cloned settings from the finished game so the
 * lobby page can immediately show the correct teams, variant, and settings
 * without waiting for players to reconnect.
 */
export interface RematchStartPayload {
  type: 'rematch_start';
  roomCode: string;
  /** Team + seat assignments from the finished game (present when available). */
  previousTeams?: RematchPreviousTeamEntry[];
  /** Card-removal variant carried forward to the next game. */
  variant?: 'remove_2s' | 'remove_7s' | 'remove_8s';
  /** Total seat count carried forward (6 or 8). */
  playerCount?: number;
}

/**
 * Broadcast when majority yes is reached and a new game has been created
 * server-side with the same team assignments and seat order.
 *
 * After receiving this event clients should clear any post-game UI state.
 * The server immediately follows this event with personalised `game_init`
 * messages so the new game begins without a page reload.
 */
export interface RematchStartingPayload {
  type: 'rematch_starting';
  /** The room code for the new game (same as the finished game). */
  roomCode: string;
}

/** Broadcast when the vote window expired or majority voted no. */
export interface RematchDeclinedPayload {
  type: 'rematch_declined';
  reason: 'timeout' | 'majority_no';
}

/**
 * Broadcast to all clients when the room is permanently dissolved after a
 * declined rematch vote. Clients should stop trying to reconnect and show
 * a dissolution notice with a "Back to Home" call-to-action.
 *
 * Emitted shortly after `rematch_declined` so that clients have a moment to
 * display the decline reason before the final dissolution message arrives.
 */
export interface RoomDissolvedPayload {
  type: 'room_dissolved';
  /** Mirrors the rematch outcome or an automatic all-bot abandonment. */
  reason: 'timeout' | 'majority_no' | 'all_bots';
}

/**
 * Broadcast to all clients (except the declarant) while the declarant is
 * filling out the card-assignment form (Step 2 of the DeclareModal).
 *
 * Sent for every change in the in-progress assignment so all observers
 * see live updates. halfSuitId === null signals that the declaration
 * was cancelled (declarant went back or closed the modal) — clients
 * should clear the progress banner when they receive this.
 *
 * The server broadcasts this message as fire-and-forget: no state is
 * persisted. Clients that connect mid-declaration will not see earlier
 * progress, but will receive the next progress event when the declarant
 * makes the next assignment change.
 */
export interface DeclareProgressPayload {
  type: 'declare_progress';
  /** The player who is making the declaration. */
  declarerId: string;
  /**
   * Which half-suit is being declared.
   * null → declarant cancelled (went back to Step 1 or closed the modal).
   */
  halfSuitId: HalfSuitId | null;
  /** Number of cards that have been assigned so far (0–6). */
  assignedCount: number;
  /** Always 6. */
  totalCards: number;
  /**
   * Partial card → playerId assignment as submitted so far.
   * Empty when declaration is cancelled (halfSuitId === null).
   */
  assignment: Record<CardId, string>;
}

/**
 * Broadcast to all clients when a human player's turn timer expires.
 *
 * Carries any partial card-selection state the player had in progress
 * when the timer ran out (null if they hadn't started the wizard yet).
 * The actual bot-executed move follows immediately after in an ask_result
 * or declaration_result broadcast.
 */
export interface BotTakeoverPayload {
  type: 'bot_takeover';
  /** The player whose turn expired. */
  playerId: string;
  /**
   * The partial wizard state the player had reported before time ran out.
   * null → player had not reported any selection (wizard not opened).
   *
   * When present, shape mirrors the partialSelectionStore contract:
   * Ask step 2 entered (half-suit chosen):
   * { flow: 'ask', halfSuitId: string }
   * Ask step 3 entered (card also chosen):
   * { flow: 'ask', halfSuitId: string, cardId: string }
   * Declare flow:
   * { flow: 'declare', halfSuitId: string, assignment?: Record<string, string> }
   */
  partialState: {
    flow: 'ask' | 'declare';
    halfSuitId?: string;
    cardId?: string;
    assignment?: Record<string, string>;
  } | null;
}

// ── Reconnect window events ──────────────────────────────

/**
 * Broadcast to all connected clients (except the disconnected player, who is
 * no longer connected) when a human player disconnects during an active game.
 *
 * The seat is temporarily filled by a bot for the duration of the reconnect
 * window. Clients should show a "disconnected — reconnecting…" badge on the
 * affected seat with a countdown to `expiresAt`.
 */
export interface PlayerDisconnectedPayload {
  type: 'player_disconnected';
  /** The player who disconnected. */
  playerId: string;
  /** Total reconnect window duration in ms (always 60 000). */
  reconnectWindowMs: number;
  /** Epoch ms timestamp when the reconnect window expires. */
  expiresAt: number;
}

/**
 * Broadcast to all OTHER connected clients when a disconnected player
 * reconnects within the 60-second window and reclaims their seat.
 *
 * The bot that was filling the seat is evicted and the human resumes play.
 * Clients should clear the "disconnected" badge and restore the player avatar.
 */
export interface PlayerReconnectedPayload {
  type: 'player_reconnected';
  /** The player who reconnected. */
  playerId: string;
  /** Their display name (unchanged from before the disconnect). */
  displayName: string;
}

/**
 * Broadcast to all connected clients when the 60-second reconnect window
 * expires without the player returning. The bot that replaced them takes
 * over the seat permanently for the rest of the game.
 */
export interface ReconnectExpiredPayload {
  type: 'reconnect_expired';
  /** The player whose reconnect window expired. */
  playerId: string;
}

// ── Player elimination ──────────────────────────────────────────

/**
 * Broadcast to all connected clients when a player's hand is emptied by a
 * declaration. Also included in the updated `game_players` broadcast (via
 * the `isEliminated` flag), but this explicit event lets clients show a toast
 * or animation immediately on elimination.
 */
export interface PlayerEliminatedPayload {
  type: 'player_eliminated';
  /** The player whose hand just reached 0 cards. */
  playerId: string;
  /** Their display name for the toast/notification. */
  displayName: string;
  /** Their team (1 or 2) for colour-coding the notification. */
  teamId: 1 | 2;
}

/**
 * Sent ONLY to the eliminated human player. Prompts them to choose which
 * teammate should receive future turns on their behalf.
 *
 * The game continues regardless of whether/when the player responds.
 * The server stores the choice in `gs.turnRecipients` once received, but the
 * immediate turn was already determined by `_resolveValidTurn` on the server.
 */
export interface ChooseTurnRecipientPromptPayload {
  type: 'choose_turn_recipient_prompt';
  /** The eliminated player's own ID (same as myPlayerId when received). */
  eliminatedPlayerId: string;
  /** Teammates who still have cards and can receive the turn. */
  eligibleTeammates: Array<{ playerId: string; displayName: string }>;
}

// ── Card display helpers ─────────────────────────────────────────────────────

const RANK_DISPLAY: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};

export function parseCard(id: CardId): ParsedCard {
  const [rankStr, suit] = id.split('_');
  const rank = parseInt(rankStr, 10) as CardRank;
  return { rank, suit: suit as CardSuit, id };
}

export function cardRankLabel(rank: CardRank): string {
  return RANK_DISPLAY[rank] ?? String(rank);
}

export const SUIT_SYMBOLS: Record<CardSuit, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
};

export const SUIT_NAMES: Record<CardSuit, string> = {
  s: 'Spades',
  h: 'Hearts',
  d: 'Diamonds',
  c: 'Clubs',
};

export const SUIT_COLORS: Record<CardSuit, string> = {
  s: 'text-gray-900',
  h: 'text-red-600',
  d: 'text-red-600',
  c: 'text-gray-900',
};

export const SUIT_BORDER_COLORS: Record<CardSuit, string> = {
  s: 'border-gray-700',
  h: 'border-red-400',
  d: 'border-red-400',
  c: 'border-gray-700',
};

export function cardLabel(card: CardId): string {
  const { rank, suit } = parseCard(card);
  return `${cardRankLabel(rank)}${SUIT_SYMBOLS[suit]}`;
}

export function halfSuitLabel(halfSuitId: HalfSuitId): string {
  const [tier, suit] = halfSuitId.split('_');
  const tierLabel = tier === 'low' ? 'Low' : 'High';
  return `${tierLabel} ${SUIT_NAMES[suit as CardSuit] ?? suit}`;
}

// ── Half-suit card compositions ───────────────────────────────────────────────

const ALL_RANKS_SORTED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

function getRemainingRanks(variant: 'remove_2s' | 'remove_7s' | 'remove_8s'): number[] {
  const REMOVED: Record<string, number> = { remove_2s: 2, remove_7s: 7, remove_8s: 8 };
  return ALL_RANKS_SORTED.filter((r) => r !== REMOVED[variant]);
}

export function getHalfSuitCards(
  halfSuitId: HalfSuitId,
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s'
): CardId[] {
  const [tier, suit] = halfSuitId.split('_');
  const remaining = getRemainingRanks(variant);
  const ranks = tier === 'low' ? remaining.slice(0, 6) : remaining.slice(6, 12);
  return ranks.map((r) => `${r}_${suit}`);
}

export function getCardHalfSuit(
  cardId: CardId,
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s'
): HalfSuitId | null {
  const [rankStr, suit] = cardId.split('_');
  const rank = parseInt(rankStr, 10);
  const remaining = getRemainingRanks(variant);
  const idx = remaining.indexOf(rank);
  if (idx === -1) return null;
  return idx < 6 ? `low_${suit}` : `high_${suit}`;
}

export function allHalfSuitIds(): HalfSuitId[] {
  const ids: HalfSuitId[] = [];
  for (const tier of ['low', 'high']) {
    for (const suit of ['s', 'h', 'd', 'c']) {
      ids.push(`${tier}_${suit}`);
    }
  }
  return ids;
}
