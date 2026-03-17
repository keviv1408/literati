/**
 * Rooms API routes
 *
 * POST /api/rooms — Create a new private game room
 * GET /api/rooms/:code — Fetch room details by code
 * POST /api/rooms/:code/join — Join a room (blocked players receive 403)
 * POST /api/rooms/:code/kick — Host kicks a player (adds them to per-room blocklist)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Stricter limit for room creation only (not reads)
const roomCreationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many room creation attempts, please wait' },
  skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development',
});
const { getSupabaseClient } = require('../db/supabase');
const {
  generateUniqueRoomCode,
  generateInviteCode,
  generateSpectatorToken,
} = require('../utils/roomCode');
const { requireAuth } = require('../middleware/auth');
const {
  blockPlayer,
  isBlocked,
  getBlockedPlayers,
  getPlayerIdentifier,
} = require('../rooms/roomBlocklist');
const { getIO, getConnectedUsers } = require('../socket/server');

// In-memory map: roomId → guest sessionId (for guest-hosted rooms).
// Guest sessions are already ephemeral/in-memory, so this is consistent.
const guestHostMap = new Map();

/**
 * Check if the current user is the host of a room.
 * For registered users, compares against host_user_id in DB.
 * For guests, compares against the in-memory guestHostMap.
 */
function isRoomHost(room, user) {
  if (user.isGuest) {
    return guestHostMap.get(room.id) === user.sessionId;
  }
  return room.host_user_id === user.id;
}

/**
 * Valid player counts for a Literature game room.
 * The spec allows 6 or 8 players (evenly split into two teams).
 */
const VALID_PLAYER_COUNTS = [6, 8];

/**
 * Valid card-removal variants.
 * The host selects which rank is removed from the standard 52-card deck
 * to produce the 48-card Literature deck.
 *
 * remove_2s — remove all four 2s
 * remove_7s — remove all four 7s (classic variant)
 * remove_8s — remove all four 8s
 */
const VALID_CARD_REMOVAL_VARIANTS = ['remove_2s', 'remove_7s', 'remove_8s'];

/**
 * Room status values.
 */
const ROOM_STATUS = {
  WAITING: 'waiting',    // Waiting for players to join
  STARTING: 'starting',  // All seats filled, countdown in progress
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const ACTIVE_ROOM_STATUSES = new Set([
  ROOM_STATUS.WAITING,
  ROOM_STATUS.STARTING,
  ROOM_STATUS.IN_PROGRESS,
]);

/**
 * GET /api/rooms/spectate/:token
 *
 * Resolve a private spectator token to room details.
 *
 * Private room spectator links embed a 32-char hex spectator_token as their
 * path parameter (e.g. /spectate/<TOKEN>). This endpoint converts that token
 * back to the room code and public room metadata so the frontend can navigate
 * to the correct lobby or game page as a spectator.
 *
 * For matchmaking games the spectator URL is public (/room/<CODE>?spectate=1)
 * and does not need this resolution step — the room code is already in the URL.
 *
 * Response 200: { roomCode: string, room: { id, code, player_count, card_removal_variant, status, is_matchmaking, created_at, updated_at } }
 * Response 400: { error: 'Invalid spectator token format' }
 * Response 404: { error: 'Room not found' }
 * Response 500: internal error
 */
router.get('/spectate/:token', async (req, res) => {
  const { token } = req.params;

  // ── Validate token format — must be exactly 32 hex chars ─────────────────
  if (
    !token ||
    typeof token !== 'string' ||
    !/^[0-9A-Fa-f]{32}$/.test(token)
  ) {
    return res.status(400).json({ error: 'Invalid spectator token format' });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select(
        'id, code, player_count, card_removal_variant, status, is_matchmaking, created_at, updated_at'
      )
      // Tokens are stored uppercase; normalise the input so both cases match.
      .eq('spectator_token', token.toUpperCase())
      .maybeSingle();

    if (error) {
      console.error('[spectate] Error validating spectator token:', error);
      return res.status(500).json({ error: 'Failed to validate spectator token' });
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Return both a full room object AND individual flat fields so that
    // clients can use whichever shape is more convenient.
    return res.status(200).json({
      roomCode:           room.code,
      playerCount:        room.player_count,
      cardRemovalVariant: room.card_removal_variant,
      status:             room.status,
      isMatchmaking:      !!room.is_matchmaking,
      room,
    });
  } catch (err) {
    console.error('[spectate] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/rooms
 *
 * Create a new private game room.
 *
 * Request body:
 * playerCount {number} 6 or 8
 * cardRemovalVariant {string} 'remove_2s' | 'remove_7s' | 'remove_8s'
 *
 * The authenticated user becomes the room host. Host userId is derived from
 * the validated JWT (req.user.id) rather than the request body to prevent
 * spoofing.
 *
 * Response 201:
 * {
 * room: {
 * id, code, invite_code, spectator_token,
 * host_user_id, player_count, card_removal_variant,
 * status, created_at, updated_at
 * },
 * inviteLink: string — ready-made player join URL
 * spectatorLink: string — ready-made private spectator URL (token-based)
 * }
 *
 * invite_code — 16-char hex token for the player invite link (/join/:invite_code).
 * spectator_token — 32-char hex token for the spectator view link (/spectate/:spectator_token).
 * spectatorLink — full URL using the spectator_token (convenience field for the host).
 *
 * Errors:
 * 400 — invalid input
 * 409 — host already has an active game
 * 500 — internal error
 */
router.post('/', roomCreationLimiter, requireAuth, async (req, res) => {
  const { playerCount, cardRemovalVariant } = req.body;
  const hostUserId = req.user.isGuest ? req.user.sessionId : req.user.id;
  // For DB writes, guests don't exist in the users table so host_user_id must be null.
  const hostUserIdForDb = req.user.isGuest ? null : req.user.id;

  // ── Input validation ────────────────────────────────────────────────────────

  const validationErrors = [];

  if (playerCount === undefined || playerCount === null) {
    validationErrors.push('playerCount is required');
  } else if (!VALID_PLAYER_COUNTS.includes(Number(playerCount))) {
    validationErrors.push(
      `playerCount must be one of: ${VALID_PLAYER_COUNTS.join(', ')}`
    );
  }

  if (!cardRemovalVariant) {
    validationErrors.push('cardRemovalVariant is required');
  } else if (!VALID_CARD_REMOVAL_VARIANTS.includes(cardRemovalVariant)) {
    validationErrors.push(
      `cardRemovalVariant must be one of: ${VALID_CARD_REMOVAL_VARIANTS.join(', ')}`
    );
  }

  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validationErrors,
    });
  }

  const supabase = getSupabaseClient();

  // ── Enforce one active game per account ─────────────────────────────────────
  // A host may not create a new room while they have an existing room that is
  // waiting, starting, or in progress.
  if (req.user.isGuest) {
    // For guests, check the in-memory map (host_user_id is null in DB).
    for (const [roomId, guestId] of guestHostMap.entries()) {
      if (guestId !== hostUserId) continue;

      let existingRoom = { id: roomId };

      try {
        const { data: roomRecord, error: roomLookupError } = await supabase
          .from('rooms')
          .select('id, code, status')
          .eq('id', roomId)
          .maybeSingle();

        if (roomLookupError) {
          console.error('Error looking up existing guest room:', roomLookupError);
        } else if (!roomRecord || !ACTIVE_ROOM_STATUSES.has(roomRecord.status)) {
          // Stale guest-host binding: the room was removed or has already
          // reached a terminal state, so it should not block new room creation.
          guestHostMap.delete(roomId);
          continue;
        } else {
          existingRoom = {
            id: roomRecord.id,
            code: roomRecord.code,
            status: roomRecord.status,
          };
        }
      } catch (err) {
        console.error('Unexpected error looking up existing guest room:', err);
      }

      return res.status(409).json({
        error: 'You already have an active game room',
        existingRoom,
      });
    }
  } else {
    try {
      const { data: existingRoom, error: existingError } = await supabase
        .from('rooms')
        .select('id, code, status')
        .eq('host_user_id', hostUserIdForDb)
        .in('status', [
          ROOM_STATUS.WAITING,
          ROOM_STATUS.STARTING,
          ROOM_STATUS.IN_PROGRESS,
        ])
        .maybeSingle();

      if (existingError) {
        console.error('Error checking existing rooms:', existingError);
        return res.status(500).json({ error: 'Failed to validate room eligibility' });
      }

      if (existingRoom) {
        return res.status(409).json({
          error: 'You already have an active game room',
          existingRoom: {
            id: existingRoom.id,
            code: existingRoom.code,
            status: existingRoom.status,
          },
        });
      }
    } catch (err) {
      console.error('Unexpected error checking existing rooms:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── Generate unique room code + secure tokens ────────────────────────────────
  let roomCode;
  let inviteCode;
  let spectatorToken;
  try {
    roomCode = await generateUniqueRoomCode(supabase);
    inviteCode = generateInviteCode();
    spectatorToken = generateSpectatorToken();
  } catch (err) {
    console.error('Error generating room code or tokens:', err);
    return res.status(500).json({ error: 'Failed to generate room code' });
  }

  // ── Persist room to Supabase ─────────────────────────────────────────────────
  try {
    const { data: room, error: insertError } = await supabase
      .from('rooms')
      .insert({
        code: roomCode,
        invite_code: inviteCode,
        spectator_token: spectatorToken,
        host_user_id: hostUserIdForDb,
        player_count: Number(playerCount),
        card_removal_variant: cardRemovalVariant,
        status: ROOM_STATUS.WAITING,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error inserting room:', insertError);
      return res.status(500).json({ error: 'Failed to create room' });
    }

    // Track guest host in memory so authorization checks work later.
    if (req.user.isGuest) {
      guestHostMap.set(room.id, hostUserId);
    }

    // ── Build convenience URLs for the host ────────────────────────────────────
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteLink    = `${frontendUrl}/room/${room.code}`;
    // Private rooms use the token-based spectator URL so the link is not
    // guessable from the room code alone.
    const spectatorLink = `${frontendUrl}/spectate/${room.spectator_token}`;

    // ── Emit room-created socket event to host ─────────────────────────────────
    // Non-fatal: the REST response is the source of truth. The socket event is
    // a supplemental real-time notification that delivers the same data along
    // with ready-made links to any connected socket client.
    try {
      const io = getIO();
      if (io && hostUserId) {
        const connectedUsers = getConnectedUsers();
        const socketId = connectedUsers.get(hostUserId);
        if (socketId) {
          io.to(socketId).emit('room-created', {
            room,
            inviteCode:    room.invite_code,
            inviteLink,
            spectatorLink,
          });
        }
      }
    } catch (emitErr) {
      // Never let a socket error abort the successful HTTP response.
      console.warn('[socket] room-created emit failed:', emitErr.message);
    }

    // Return room details plus convenience links so the host page can display
    // them immediately without a second round-trip.
    return res.status(201).json({ room, inviteLink, spectatorLink });
  } catch (err) {
    console.error('Unexpected error creating room:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/rooms/active
 *
 * Returns up to 20 rooms currently in progress.
 * Public endpoint — no auth required.
 *
 * Each returned room includes a `spectatorUrl` field:
 * - Matchmaking rooms: `/room/<CODE>?spectate=1` (public, no token)
 * - Private rooms: `/spectate/<SPECTATOR_TOKEN>` (token-gated)
 *
 * Response 200: { rooms: [..., spectatorUrl: string] }
 * Response 500: { error: 'Failed to load active rooms' }
 */
router.get('/active', async (req, res) => {
  const supabase = getSupabaseClient();

  try {
    const { data: rooms, error } = await supabase
      .from('rooms')
      .select('id, code, player_count, card_removal_variant, status, is_matchmaking, spectator_token, created_at, updated_at')
      .eq('status', ROOM_STATUS.IN_PROGRESS)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Error fetching active rooms:', error);
      return res.status(500).json({ error: 'Failed to load active rooms' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // Attach per-room spectator URLs and strip the raw token from the response.
    const enrichedRooms = (rooms || []).map(({ spectator_token, is_matchmaking, ...rest }) => ({
      ...rest,
      is_matchmaking: !!is_matchmaking,
      // Matchmaking rooms are public → use the code-based URL.
      // Private rooms use the token-based URL to keep the link unguessable.
      spectatorUrl: is_matchmaking
        ? `${frontendUrl}/room/${rest.code}?spectate=1`
        : `${frontendUrl}/spectate/${spectator_token}`,
    }));

    return res.status(200).json({ rooms: enrichedRooms });
  } catch (err) {
    console.error('Unexpected error fetching active rooms:', err);
    return res.status(500).json({ error: 'Failed to load active rooms' });
  }
});

/**
 * GET /api/rooms/:code
 *
 * Fetch room details by room code.
 * Public endpoint — no auth required (spectators need to look up rooms).
 *
 * Note: spectator_token is intentionally excluded from this public response.
 * It is only returned to the host at room-creation time (POST 201).
 * invite_code is included so the host can copy the join link from the
 * lobby page after a browser refresh.
 *
 * Response 200: { room: { ... } }
 * Response 404: { error: 'Room not found' }
 */
router.get('/:code', async (req, res) => {
  const { code } = req.params;

  if (!code || typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select(
        'id, code, invite_code, host_user_id, player_count, card_removal_variant, status, is_matchmaking, created_at, updated_at'
      )
      .eq('code', code.toUpperCase())
      .maybeSingle();

    if (error) {
      console.error('Error fetching room:', error);
      return res.status(500).json({ error: 'Failed to fetch room' });
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    return res.status(200).json({ room });
  } catch (err) {
    console.error('Unexpected error fetching room:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/rooms/:code/join
 *
 * Attempt to join a room by its code.
 * Requires authentication (guest or registered).
 *
 * Blocklist check: if the authenticated player's identifier appears on the
 * per-room blocklist they are rejected with 403 and cannot rejoin.
 *
 * This endpoint performs the eligibility gate; actual seat assignment is
 * handled by the WebSocket layer once the client connects.
 *
 * Response 200: { allowed: true, roomCode: string }
 * Response 400: { error: 'Invalid room code format' }
 * Response 401: unauthenticated
 * Response 403: { error: 'You have been removed from this room and cannot rejoin' }
 * Response 404: { error: 'Room not found' }
 * Response 410: { error: 'This room is no longer accepting players' }
 */
router.post('/:code/join', requireAuth, async (req, res) => {
  const { code } = req.params;

  // ── Validate room code format ────────────────────────────────────────────────
  if (!code || typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  const roomCode = code.toUpperCase();

  // ── Blocklist check ──────────────────────────────────────────────────────────
  // Derive the stable player identifier from the resolved session.
  const playerId = getPlayerIdentifier(req.user);

  if (playerId && isBlocked(roomCode, playerId)) {
    return res.status(403).json({
      error: 'You have been removed from this room and cannot rejoin',
    });
  }

  // ── Room existence and status check ─────────────────────────────────────────
  const supabase = getSupabaseClient();

  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select('id, code, status, player_count')
      .eq('code', roomCode)
      .maybeSingle();

    if (error) {
      console.error('Error fetching room for join:', error);
      return res.status(500).json({ error: 'Failed to look up room' });
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Rooms that are completed or cancelled no longer accept new players.
    if (
      room.status === ROOM_STATUS.COMPLETED ||
      room.status === ROOM_STATUS.CANCELLED
    ) {
      return res.status(410).json({
        error: 'This room is no longer accepting players',
      });
    }

    return res.status(200).json({ allowed: true, roomCode: room.code });
  } catch (err) {
    console.error('Unexpected error in join route:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/rooms/:code/kick
 *
 * Host kicks (permanently removes) a player from the room.
 *
 * Only the room host may kick players. The kicked player's identifier is added
 * to the per-room in-memory blocklist so they cannot rejoin via
 * POST /api/rooms/:code/join or via the WebSocket handshake.
 *
 * Request body:
 * targetPlayerId {string} The stable identifier of the player to kick.
 * For registered users this is their user UUID.
 * For guests this is their guest sessionId.
 *
 * Response 200: { kicked: true, targetPlayerId: string }
 * Response 400: { error: '...' }
 * Response 401: unauthenticated
 * Response 403: { error: 'Only the room host can kick players' }
 * Response 404: { error: 'Room not found' }
 * Response 409: { error: 'Cannot kick from a completed or cancelled room' }
 */
router.post('/:code/kick', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { targetPlayerId } = req.body;

  // ── Validate room code ───────────────────────────────────────────────────────
  if (!code || typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  // ── Validate targetPlayerId ──────────────────────────────────────────────────
  if (!targetPlayerId || typeof targetPlayerId !== 'string' || targetPlayerId.trim().length === 0) {
    return res.status(400).json({ error: 'targetPlayerId is required' });
  }

  const roomCode = code.toUpperCase();

  // ── Guests cannot be hosts (no host_user_id mapping for guests) ──────────────
  // The rooms table stores host_user_id as a registered-user UUID; guests
  // currently cannot own rooms in MVP. Reject guest kick attempts early.
  if (req.user.isGuest) {
    return res.status(403).json({ error: 'Only the room host can kick players' });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select('id, code, host_user_id, status')
      .eq('code', roomCode)
      .maybeSingle();

    if (error) {
      console.error('Error fetching room for kick:', error);
      return res.status(500).json({ error: 'Failed to look up room' });
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // ── Verify requester is the room host ────────────────────────────────────
    if (!isRoomHost(room, req.user)) {
      return res.status(403).json({ error: 'Only the room host can kick players' });
    }

    // ── Reject kick on terminal rooms ────────────────────────────────────────
    if (
      room.status === ROOM_STATUS.COMPLETED ||
      room.status === ROOM_STATUS.CANCELLED
    ) {
      return res.status(409).json({
        error: 'Cannot kick from a completed or cancelled room',
      });
    }

    // ── Add to per-room blocklist ─────────────────────────────────────────────
    blockPlayer(roomCode, targetPlayerId.trim());

    return res.status(200).json({
      kicked: true,
      targetPlayerId: targetPlayerId.trim(),
    });
  } catch (err) {
    console.error('Unexpected error in kick route:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/rooms/:code/blocklist
 *
 * Return the current blocklist for a room.
 * Only the room host may query this endpoint.
 *
 * Response 200: { roomCode: string, blockedPlayers: string[] }
 */
router.get('/:code/blocklist', requireAuth, async (req, res) => {
  const { code } = req.params;

  if (!code || typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  const roomCode = code.toUpperCase();

  // Guests cannot own rooms
  if (req.user.isGuest) {
    return res.status(403).json({ error: 'Only the room host can view the blocklist' });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: room, error } = await supabase
      .from('rooms')
      .select('id, host_user_id')
      .eq('code', roomCode)
      .maybeSingle();

    if (error) {
      console.error('Error fetching room for blocklist:', error);
      return res.status(500).json({ error: 'Failed to look up room' });
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (!isRoomHost(room, req.user)) {
      return res.status(403).json({ error: 'Only the room host can view the blocklist' });
    }

    return res.status(200).json({
      roomCode,
      blockedPlayers: getBlockedPlayers(roomCode),
    });
  } catch (err) {
    console.error('Unexpected error fetching blocklist:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/rooms/:code/start
 *
 * Host explicitly starts a private room game.
 *
 * This endpoint validates and processes the game-start request server-side,
 * enforcing:
 * - Requester must be the room host (registered users only; guests cannot host).
 * - Room must be in 'waiting' status.
 * - Current connected human player count must not exceed the room's playerCount.
 * - Neither team may have more than playerCount/2 human players (team-balance rule).
 *
 * On success:
 * - Remaining seats are filled with bots (alternating seatIndex layout).
 * - In-memory GameState is created via gameSocketServer.createGame().
 * - Room status is set to 'starting' in Supabase.
 * - Initial game snapshot is persisted asynchronously (transitions → 'in_progress').
 * - 'game_starting' event is broadcast to all /ws/room/<CODE> WebSocket clients.
 *
 * Response 200:
 * { started: true, roomCode, seats: LobbySeat[], botsAdded: string[] }
 *
 * Errors:
 * 400 — player count / team balance validation failed
 * 403 — not the host (or guest user)
 * 404 — room not found
 * 409 — room is not in 'waiting' status
 * 500 — internal error
 */
router.post('/:code/start', requireAuth, async (req, res) => {
  const { code } = req.params;

  // ── Validate room code format ──────────────────────────────────────────────
  if (!code || typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid room code format' });
  }

  // Guests cannot be hosts in MVP
  if (req.user.isGuest) {
    return res.status(403).json({ error: 'Only registered users can host game rooms' });
  }

  const roomCode = code.toUpperCase();
  const supabase = getSupabaseClient();

  // ── Fetch room from Supabase ───────────────────────────────────────────────
  let room;
  try {
    const { data, error } = await supabase
      .from('rooms')
      .select('id, status, player_count, card_removal_variant, host_user_id')
      .eq('code', roomCode)
      .maybeSingle();

    if (error) {
      console.error('[rooms/start] DB error:', error);
      return res.status(500).json({ error: 'Failed to look up room' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Room not found' });
    }

    room = data;
  } catch (err) {
    console.error('[rooms/start] Unexpected error fetching room:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ── Host-only authorization ────────────────────────────────────────────────
  if (!isRoomHost(room, req.user)) {
    return res.status(403).json({ error: 'Only the room host can start the game' });
  }

  // ── Status guard ──────────────────────────────────────────────────────────
  if (room.status !== ROOM_STATUS.WAITING) {
    return res.status(409).json({
      error: `Cannot start: room is currently '${room.status}', expected 'waiting'`,
      code:  'ROOM_NOT_WAITING',
    });
  }

  const playerCount = room.player_count;

  // ── Read live player state from in-memory room socket store ───────────────
  // roomSocketServer.roomClients maps roomCode → Map<userId, ClientEntry>.
  // Required lazily to avoid a load-time circular-require issue.
  const {
    roomClients,
    validateStartGame,
    buildSeatsFromClients,
    broadcast: broadcastToRoomClients,
  } = require('../ws/roomSocketServer');

  const clients = roomClients.get(roomCode) || new Map();

  // ── Validate player count and team balance ───────────────────
  const validation = validateStartGame(clients, playerCount);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, code: validation.errorCode });
  }

  // ── Build human seat descriptors ──────────────────────────────────────────
  const humanSeats  = buildSeatsFromClients(clients, playerCount);
  const occupiedMap = new Map(humanSeats.map((s) => [s.seatIndex, s]));

  // ── Detect empty seats and auto-fill with bots (gameInitService) ──────────
  // buildGameSeats() calls detectEmptySeats() internally and fills each empty
  // slot with a bot player, then returns the merged sorted seat array.
  const { buildGameSeats } = require('../game/gameInitService');
  const { allSeats, botSeats, emptySlots } = buildGameSeats(playerCount, occupiedMap);
  const bots = botSeats; // alias kept for the botsAdded response field

  if (emptySlots.length > 0) {
    console.log(
      `[rooms/start] ${emptySlots.length} empty seat(s) detected in room ` +
      `${roomCode} — filling with bots at indices: ${emptySlots.join(', ')}`
    );
  }

  // ── Create in-memory game state ───────────────────────────────────────────
  let gameState;
  try {
    const { createGame, clearPendingRematchSettings } = require('../game/gameSocketServer');
    gameState = createGame({
      roomCode,
      roomId:      room.id,
      variant:     room.card_removal_variant,
      playerCount,
      seats:       allSeats,
    });
    // clear any stored pending rematch snapshot now that the new
    // game has been created — prevents stale data bleeding into future rounds.
    clearPendingRematchSettings(roomCode);
  } catch (err) {
    console.error('[rooms/start] createGame error for room', roomCode, ':', err);
    return res.status(500).json({ error: 'Failed to initialise game' });
  }

  // ── Update Supabase room status → 'starting' ──────────────────────────────
  try {
    await supabase
      .from('rooms')
      .update({ status: ROOM_STATUS.STARTING })
      .eq('code', roomCode);
  } catch (err) {
    console.error('[rooms/start] status update error for room', roomCode, ':', err);
    // Non-fatal: the in-memory game is already created; respond with success.
  }

  // ── Persist initial game snapshot asynchronously (→ 'in_progress') ────────
  process.nextTick(async () => {
    try {
      const { persistGameState } = require('../game/gameState');
      await persistGameState(gameState, supabase);
    } catch (err) {
      console.error('[rooms/start] persist error for room', roomCode, ':', err);
    }
  });

  // ── Broadcast game_starting to all WebSocket clients ──────────────────────
  broadcastToRoomClients(roomCode, {
    type:      'game_starting',
    roomCode,
    seats:     allSeats,
    botsAdded: bots.map((b) => b.playerId),
  });

  // ── Schedule first bot turn if opening player is a bot ────────────────────
  if (gameState && gameState.status === 'active') {
    const firstPlayer = gameState.players.find(
      (p) => p.playerId === gameState.currentTurnPlayerId,
    );
    if (firstPlayer && firstPlayer.isBot) {
      setTimeout(() => {
        try {
          const { scheduleBotTurnIfNeeded } = require('../game/gameSocketServer');
          scheduleBotTurnIfNeeded(gameState);
        } catch (err) {
          console.error('[rooms/start] scheduleBotTurn error for room', roomCode, ':', err);
        }
      }, 3000);
    }
  }

  return res.status(200).json({
    started:   true,
    roomCode,
    seats:     allSeats,
    botsAdded: bots.map((b) => b.playerId),
  });
});

module.exports = router;
module.exports.VALID_PLAYER_COUNTS = VALID_PLAYER_COUNTS;
module.exports.VALID_CARD_REMOVAL_VARIANTS = VALID_CARD_REMOVAL_VARIANTS;
module.exports.ROOM_STATUS = ROOM_STATUS;
module.exports.guestHostMap = guestHostMap;
