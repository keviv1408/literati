import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createClient } from '../../../backend/node_modules/@supabase/supabase-js';
import { createStandin } from '../standin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = ['waiting', 'starting', 'in_progress'];

let standin: ReturnType<typeof createStandin>;
let base: string;
let db: ReturnType<typeof createClient>;

test.beforeEach(async () => {
  standin = createStandin();
  await new Promise<void>((resolve) => standin.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(standin.server.address() as AddressInfo).port}`;
  // The backend's own client options (backend/src/db/supabase.js).
  db = createClient(base, 'standin', { auth: { autoRefreshToken: false, persistSession: false } });
});

test.afterEach(async () => {
  standin.server.closeAllConnections();
  await new Promise((resolve) => standin.server.close(resolve));
});

// The insert shape of rooms.js for a guest host, status left to the default.
function _room(code: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    invite_code: `INV${code}`,
    spectator_token: `SPEC${code}`,
    host_user_id: null,
    host_guest_id: randomUUID(),
    player_count: 6,
    card_removal_variant: 'remove_7s',
    ...extra,
  };
}

async function _insert(row: Record<string, unknown>) {
  const { error } = await db.from('rooms').insert(row);
  expect(error).toBeNull();
}

async function _report(): Promise<{ unknown: string[]; refused: string[] }> {
  return (await fetch(`${base}/__standin/report`)).json();
}

test('insert then select single returns the row with defaults', async () => {
  const { data, error } = await db.from('rooms').insert(_room('ABCDEF')).select().single();
  expect(error).toBeNull();
  expect(data.id).toMatch(UUID);
  expect(data.code).toBe('ABCDEF');
  expect(data.status).toBe('waiting');
  expect(data.game_state).toBeNull();
  expect(data.is_matchmaking).toBe(false);
  expect(Date.parse(data.created_at)).not.toBeNaN();
  expect(Date.parse(data.updated_at)).not.toBeNaN();
  expect(await _report()).toEqual({ unknown: [], refused: [] });
});

test('maybeSingle returns null for no row, the row for one', async () => {
  const lookup = () => db.from('rooms').select('code').eq('code', 'ZZZZZZ').maybeSingle();
  const none = await lookup();
  expect(none.error).toBeNull();
  expect(none.data).toBeNull();
  await _insert(_room('ZZZZZZ'));
  const one = await lookup();
  expect(one.error).toBeNull();
  expect(one.data).toEqual({ code: 'ZZZZZZ' });
});

test('single errors on no row', async () => {
  const { data, error } = await db.from('rooms').select('host_user_id, is_matchmaking').eq('code', 'ZZZZZZ').single();
  expect(data).toBeNull();
  expect(error?.code).toBe('PGRST116');
});

test('eq, in, order, limit together', async () => {
  const host = randomUUID();
  await _insert(_room('OLDEST', { host_guest_id: host }));
  await _insert(_room('NEWERR', { host_guest_id: host, status: 'in_progress' }));
  await _insert(_room('ENDEDD', { host_guest_id: host, status: 'completed' }));
  await _insert(_room('OTHERR'));
  const { data, error } = await db
    .from('rooms')
    .select('id, code, status')
    .eq('host_guest_id', host)
    .in('status', ACTIVE)
    .order('created_at', { ascending: false })
    .limit(1);
  expect(error).toBeNull();
  expect(data).toEqual([{ id: expect.stringMatching(UUID), code: 'NEWERR', status: 'in_progress' }]);
});

test('update bumps updated_at and filters on two columns', async () => {
  await _insert(_room('WAITNG'));
  await _insert(_room('STARTG', { status: 'starting' }));
  const read = async (code: string) =>
    (await db.from('rooms').select('host_guest_id, updated_at').eq('code', code).single()).data;
  const before = { waiting: await read('WAITNG'), starting: await read('STARTG') };
  const newHost = randomUUID();
  for (const code of ['WAITNG', 'STARTG']) {
    const { error } = await db
      .from('rooms')
      .update({ host_user_id: null, host_guest_id: newHost })
      .eq('code', code)
      .eq('status', 'waiting');
    expect(error).toBeNull();
  }
  const waiting = await read('WAITNG');
  expect(waiting.host_guest_id).toBe(newHost);
  expect(Date.parse(waiting.updated_at)).toBeGreaterThan(Date.parse(before.waiting.updated_at));
  expect(await read('STARTG')).toEqual(before.starting);
});

test('update game_state round-trips a nested object', async () => {
  await _insert(_room('SAVEDD'));
  const snapshot = {
    variant: 'remove_7s',
    currentTurnPlayerId: 'p1',
    scores: { team1: 1, team2: 0 },
    players: [{ playerId: 'p1', isBot: false, hand: ['1_s', '2_h'] }],
    declaredSuits: [{ halfSuitId: 'low_s', teamId: 1 }],
    moveHistory: [{ type: 'ask', success: true, cardId: null }],
  };
  const saved = await db.from('rooms').update({ game_state: snapshot, status: 'in_progress' }).eq('code', 'SAVEDD');
  expect(saved.error).toBeNull();
  const { data, error } = await db.from('rooms').select('id, status, game_state').eq('code', 'SAVEDD').maybeSingle();
  expect(error).toBeNull();
  expect(data.status).toBe('in_progress');
  expect(data.game_state).toEqual(snapshot);
});

test('writes apply in arrival order', async () => {
  await _insert(_room('ORDERR'));
  // supabase-js's auth lock can put the second of two overlapping calls on the wire first.
  const arrived: number[] = [];
  standin.server.prependListener('request', (req) => {
    if (req.headers['x-save']) arrived.push(Number(req.headers['x-save']));
  });
  const save = (n: number) =>
    db
      .from('rooms')
      .update({ game_state: { n }, status: 'in_progress' })
      .eq('code', 'ORDERR')
      .setHeader('x-save', String(n));
  const results = await Promise.all([save(1), save(2)]);
  expect(results.map((r) => r.error)).toEqual([null, null]);
  expect([...arrived].sort()).toEqual([1, 2]);
  const { data } = await db.from('rooms').select('game_state').eq('code', 'ORDERR').single();
  expect(data.game_state).toEqual({ n: arrived[1] });
});

test('a client killed mid-body changes nothing and the stand-in keeps answering', async () => {
  await _insert(_room('KILLED'));
  const sock = connect((standin.server.address() as AddressInfo).port, '127.0.0.1');
  await new Promise((resolve) => sock.once('connect', resolve));
  const arrived = new Promise<IncomingMessage>((resolve) => standin.server.prependOnceListener('request', resolve));
  const body = JSON.stringify({ game_state: { n: 1 }, status: 'in_progress' });
  sock.write(
    'PATCH /rest/v1/rooms?code=eq.KILLED HTTP/1.1\r\nHost: standin\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`,
  );
  const req = await arrived;
  const closed = new Promise((resolve) => req.once('close', resolve));
  sock.destroy();
  await closed;
  expect(await _report()).toEqual({ unknown: [], refused: [] });
  const { data } = await db.from('rooms').select('status, game_state').eq('code', 'KILLED').single();
  expect(data).toEqual({ status: 'waiting', game_state: null });
});

test('duplicate code is refused', async () => {
  await _insert(_room('TWICEE'));
  const { error } = await db
    .from('rooms')
    .insert(_room('TWICEE', { invite_code: 'OTHERINVITE', spectator_token: 'OTHERSPECTATOR' }));
  expect(error?.code).toBe('23505');
  const { data } = await db.from('rooms').select('code');
  expect(data).toEqual([{ code: 'TWICEE' }]);
});

test('unknown column is refused', async () => {
  await _insert(_room('COLUMN'));
  const write = await db.from('rooms').update({ nope: 1 }).eq('code', 'COLUMN');
  expect(write.error?.code).toBe('PGRST204');
  const read = await db.from('rooms').select('nope');
  expect(read.error?.code).toBe('42703');
  const { refused } = await _report();
  expect(refused).toHaveLength(2);
  for (const line of refused) expect(line).toContain('nope');
});

test('constraints are refused', async () => {
  await _insert(_room('CHECKS'));
  const badStatus = await db.from('rooms').update({ status: 'bogus' }).eq('code', 'CHECKS');
  expect(badStatus.error?.code).toBe('22P02');
  const badCount = await db.from('rooms').insert(_room('SEVENN', { player_count: 7 }));
  expect(badCount.error?.code).toBe('23514');
  const twoHosts = await db.from('rooms').insert(_room('TWOHST', { host_user_id: randomUUID() }));
  expect(twoHosts.error?.code).toBe('23514');
  const { data } = await db.from('rooms').select('code, status');
  expect(data).toEqual([{ code: 'CHECKS', status: 'waiting' }]);
  expect((await _report()).refused).toHaveLength(3);
});

test('rpc mark_stale_games_abandoned returns 0', async () => {
  const { data, error } = await db.rpc('mark_stale_games_abandoned', { stale_after: '7200 seconds' });
  expect(error).toBeNull();
  expect(data).toBe(0);
});

test('auth user is a fast 401 with a JSON body', async () => {
  const started = Date.now();
  const res = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: 'Bearer stale' } });
  const body = await res.json();
  expect(Date.now() - started).toBeLessThan(500);
  expect(res.status).toBe(401);
  expect(body).toEqual(expect.any(Object));
  const { data, error } = await db.auth.getUser('stale');
  expect(data.user).toBeNull();
  expect(error?.status).toBe(401);
});

test('an unknown route is remembered', async () => {
  const { error } = await db.from('user_stats').select('*');
  expect(error).not.toBeNull();
  const { unknown } = await _report();
  expect(unknown).toHaveLength(1);
  expect(unknown[0]).toContain('user_stats');
});
