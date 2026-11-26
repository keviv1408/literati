import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SoakFailure, failure } from '../lib/fail';
import { BACKEND_URL, STANDIN_URL } from '../lib/limits';
import { backendEnv, killChildren, startStack, type Stack } from '../lib/stack';

const STOP_BACKEND = 'Stop the dev backend first. Kill the nodemon parent too.';
const STANDIN_TAKEN = 'Port 54321 is taken. The stand-in needs it.';
const LEASH = path.resolve(__dirname, '../leash.js');

async function _squat(port: number, host: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => res.end('squatter'));
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const reach = host === '::' ? '127.0.0.1' : host;
  return { server, url: `http://${reach.includes(':') ? `[${reach}]` : reach}:${port}/` };
}

async function _close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// A stack that starts by mistake is stopped, so a failing test leaves nothing on the ports.
async function _refusal(starting: Promise<Stack>): Promise<unknown> {
  return starting.then(
    async (stack) => {
      await stack.stop();
      return null;
    },
    (err) => err,
  );
}

function _alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function _json(body: unknown, token?: string): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

test('stand-in mode: health, database, restart keep the room', async () => {
  const stack = await startStack('standin', test.info().outputDir);
  try {
    expect((await fetch(`${BACKEND_URL}/health`)).status).toBe(200);
    expect((await fetch(`${BACKEND_URL}/health/db`)).status).toBe(200);

    const recoveryKey = randomBytes(16).toString('hex');
    const guest = await fetch(`${BACKEND_URL}/api/auth/guest`, _json({ displayName: 'Stack', recoveryKey }));
    expect(guest.status).toBe(201);
    const { token } = await guest.json();
    const created = await fetch(`${BACKEND_URL}/api/rooms`, _json({ playerCount: 6, cardRemovalVariant: 'remove_7s' }, token));
    expect(created.status).toBe(201);
    const { room } = await created.json();

    await stack.killBackend();
    await expect(fetch(`${BACKEND_URL}/health`)).rejects.toThrow();
    await stack.startBackend();
    const read = await fetch(`${BACKEND_URL}/api/rooms/${room.code}`);
    expect(read.status).toBe(200);
    expect((await read.json()).room.code).toBe(room.code);

    expect(await stack.standinReport()).toEqual({ unknown: [], refused: [] });
    expect(readFileSync(stack.backendLog, 'utf8').match(/listening on port 3012/g)).toHaveLength(2);
    expect(stack.backendLogTail(2).split('\n')[0]).toBe('--- backend.log ---');
  } finally {
    await stack.stop();
  }
  await expect(fetch(`${BACKEND_URL}/health`)).rejects.toThrow();
  await expect(fetch(`${STANDIN_URL}/__standin/report`)).rejects.toThrow();
});

test('a stand-in that dies mid-run is named', async () => {
  const stack = await startStack('standin', test.info().outputDir);
  try {
    const pid = Number(execFileSync('pgrep', ['-P', String(process.pid), '-f', 'standin.js'], { encoding: 'utf8' }).trim());
    process.kill(pid, 'SIGKILL');
    while (_alive(pid)) await sleep(20);
    const err = await stack.standinReport().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SoakFailure);
    expect((err as Error).message).toBe('the stand-in died (SIGKILL)');
    await stack.killBackend();
    await expect(stack.startBackend()).rejects.toThrow('the stand-in died (SIGKILL)');
  } finally {
    await stack.stop();
  }
});

// A dev backend bound to one loopback family only must still be seen.
for (const host of ['::', '127.0.0.1', '::1']) {
  test(`refuses to start when 3012 is taken on ${host}, and leaves that process alone`, async () => {
    const squatter = await _squat(3012, host);
    try {
      const err = await _refusal(startStack('standin', test.info().outputDir));
      expect(err).toBeInstanceOf(SoakFailure);
      expect((err as Error).message).toBe(STOP_BACKEND);
      expect(await (await fetch(squatter.url)).text()).toBe('squatter');
      await expect(fetch(`${STANDIN_URL}/__standin/report`)).rejects.toThrow();
    } finally {
      await _close(squatter.server);
    }
  });
}

for (const host of ['127.0.0.1', '::1']) {
  test(`refuses to start when 54321 is taken on ${host}`, async () => {
    const squatter = await _squat(54321, host);
    try {
      const err = await _refusal(startStack('standin', test.info().outputDir));
      expect(err).toBeInstanceOf(SoakFailure);
      expect((err as Error).message).toBe(STANDIN_TAKEN);
      expect(await (await fetch(squatter.url)).text()).toBe('squatter');
      await expect(fetch(`${BACKEND_URL}/health`)).rejects.toThrow();
    } finally {
      await _close(squatter.server);
    }
  });
}

test('killChildren ends every child', async () => {
  // Leashed, so a worker killed before killChildren runs leaves no child behind.
  const children = [0, 1].map(() =>
    spawn(process.execPath, ['--require', LEASH, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'ignore', 'ignore'] }),
  );
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('spawn', resolve))));
  const started = Date.now();
  await killChildren(children);
  expect(Date.now() - started).toBeLessThan(2_000);
  for (const child of children) expect(child.signalCode).toBe('SIGKILL');
  await killChildren(children);
});

test('a leashed child dies with a parent that was killed without cleanup', async () => {
  // String(): Playwright sets FORCE_COLOR, which would colour a logged number. The parent is leashed too, so a timed-out test leaves neither.
  const parent = spawn(
    process.execPath,
    [
      '--require',
      LEASH,
      '-e',
      `const child = require('node:child_process').spawn(process.execPath, ['--require', ${JSON.stringify(LEASH)}, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'ignore', 'inherit'] });
       child.once('spawn', () => console.log(String(child.pid)));
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let pid = 0;
  try {
    pid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk)))));
    expect(_alive(pid)).toBe(true);
    await killChildren([parent]);
    const deadline = Date.now() + 2_000;
    while (_alive(pid) && Date.now() < deadline) await sleep(50);
    expect(_alive(pid)).toBe(false);
  } finally {
    await killChildren([parent]);
    // Pid 0 would signal this whole process group.
    if (pid > 0 && _alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('real mode leaves Supabase to backend/.env', () => {
  expect(backendEnv('standin')).toMatchObject({
    PORT: '3012',
    NODE_ENV: 'development',
    SUPABASE_URL: STANDIN_URL,
    SUPABASE_SERVICE_ROLE_KEY: 'standin',
  });
  const real = backendEnv('real');
  expect(real).toMatchObject({ PORT: '3012', NODE_ENV: 'development' });
  expect(real.SUPABASE_URL).toBe(process.env.SUPABASE_URL);
  // A boolean, so a failure never prints the key.
  expect(real.SUPABASE_SERVICE_ROLE_KEY === process.env.SUPABASE_SERVICE_ROLE_KEY).toBe(true);
});

test('a failure names the seat, the kill and the move', () => {
  const where = { seat: { index: 3, name: 'Soak 4' }, kill: { id: 2, kind: 'cut' }, move: 17 };
  expect(failure('not back 5 s (took 7.4 s)', where).message).toBe('seat 3 (Soak 4) not back 5 s (took 7.4 s) after cut #2 (move 17)');
  expect(failure('the game ended before the plan').message).toBe('the game ended before the plan');
});
