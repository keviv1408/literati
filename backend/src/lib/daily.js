'use strict';

/**
 * Daily REST API helper for Literati voice rooms.
 *
 * Responsibilities:
 *   - Validate Daily env configuration
 *   - Lazily create one private Daily room per Literati room code
 *   - Mint short-lived meeting tokens for authenticated players
 *
 * Room strategy:
 *   literati-voice-<ROOMCODE>
 *
 * The room name is stable so rematches that stay inside the same Literati room
 * code can keep using the same voice room.
 */

const DAILY_API_BASE_URL = 'https://api.daily.co/v1';
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

/** @type {Map<string, { name: string, url: string }>} */
const roomCache = new Map();

class DailyRequestError extends Error {
  constructor(message, statusCode = 500, details) {
    super(message);
    this.name = 'DailyRequestError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase();
}

function buildDailyRoomName(roomCode) {
  return `literati-voice-${normalizeRoomCode(roomCode)}`;
}

function normalizeDailyDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function getConfig() {
  const apiKey = process.env.DAILY_API_KEY;
  const domain = normalizeDailyDomain(process.env.DAILY_DOMAIN);

  if (!apiKey || !domain) {
    throw new DailyRequestError(
      'Voice is unavailable because Daily is not configured on the server.',
      503,
    );
  }

  return { apiKey, domain };
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    return await response.text();
  } catch {
    return null;
  }
}

async function dailyFetch(path, init = {}) {
  const { apiKey } = getConfig();

  const response = await fetch(`${DAILY_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await parseResponseBody(response);
    const message =
      (body && typeof body === 'object' && body.error) ||
      (typeof body === 'string' && body) ||
      `Daily API request failed with HTTP ${response.status}`;

    throw new DailyRequestError(message, response.status, body);
  }

  return parseResponseBody(response);
}

async function getRoomByName(roomName) {
  try {
    return await dailyFetch(`/rooms/${encodeURIComponent(roomName)}`, {
      method: 'GET',
    });
  } catch (error) {
    if (error instanceof DailyRequestError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

function buildRoomUrl(roomName) {
  const { domain } = getConfig();
  return `https://${domain}/${roomName}`;
}

function toCachedRoom(room) {
  return {
    name: room.name,
    url: room.url || buildRoomUrl(room.name),
  };
}

async function createRoom(roomName) {
  const room = await dailyFetch('/rooms', {
    method: 'POST',
    body: JSON.stringify({
      name: roomName,
      privacy: 'private',
      properties: {
        enable_chat: false,
        enable_people_ui: false,
        enable_prejoin_ui: false,
        enable_screenshare: false,
      },
    }),
  });

  return toCachedRoom(room);
}

async function ensureRoom(roomCode) {
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  const cachedRoom = roomCache.get(normalizedRoomCode);
  if (cachedRoom) return cachedRoom;

  const roomName = buildDailyRoomName(normalizedRoomCode);
  const existingRoom = await getRoomByName(roomName);

  if (existingRoom) {
    const cached = toCachedRoom(existingRoom);
    roomCache.set(normalizedRoomCode, cached);
    return cached;
  }

  try {
    const createdRoom = await createRoom(roomName);
    roomCache.set(normalizedRoomCode, createdRoom);
    return createdRoom;
  } catch (error) {
    // Two players can race on first join. If another request created the room
    // after our GET but before our POST, re-fetch and continue.
    if (error instanceof DailyRequestError && error.statusCode === 409) {
      const room = await getRoomByName(roomName);
      if (room) {
        const cached = toCachedRoom(room);
        roomCache.set(normalizedRoomCode, cached);
        return cached;
      }
    }
    throw error;
  }
}

async function createMeetingToken({ roomName, userId, userName }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + DEFAULT_TOKEN_TTL_SECONDS;

  const response = await dailyFetch('/meeting-tokens', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_id: userId,
        user_name: userName,
        is_owner: false,
        exp: expiresAtSeconds,
        start_audio_off: true,
        start_video_off: true,
        enable_prejoin_ui: false,
        enable_screenshare: false,
      },
    }),
  });

  return {
    token: response.token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

async function joinRoom({ roomCode, userId, userName }) {
  if (!roomCode || !userId || !userName) {
    throw new DailyRequestError('roomCode, userId, and userName are required');
  }

  const room = await ensureRoom(roomCode);
  const meetingToken = await createMeetingToken({
    roomName: room.name,
    userId,
    userName,
  });

  return {
    roomName: room.name,
    roomUrl: room.url,
    meetingToken: meetingToken.token,
    expiresAt: meetingToken.expiresAt,
  };
}

function _clearRoomCache() {
  roomCache.clear();
}

module.exports = {
  DailyRequestError,
  buildDailyRoomName,
  joinRoom,
  _clearRoomCache,
};
