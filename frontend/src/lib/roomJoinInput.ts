const DEFAULT_PUBLIC_ORIGIN = 'https://literationline.com';
const ROOM_CODE = /^[A-Za-z0-9]{6}$/;
const PLAYER_INVITE_URL = /^https?:\/\/[^/?#@\\\s]+\/room\/([A-Za-z0-9]{6})\/?$/;

export function parsePlayerInviteUrl(input: string, webOrigin?: string): string | null {
  const value = input.trim();
  // Check the pasted path before URL parsing can normalize it.
  const match = PLAYER_INVITE_URL.exec(value);
  if (!match) return null;

  try {
    const { origin } = new URL(value);
    const publicOrigin = process.env.FRONTEND_URL || DEFAULT_PUBLIC_ORIGIN;
    return origin === publicOrigin || origin === webOrigin ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

export function parseRoomJoinInput(input: string, webOrigin?: string): string | null {
  const value = input.trim();
  return ROOM_CODE.test(value) ? value.toUpperCase() : parsePlayerInviteUrl(value, webOrigin);
}
