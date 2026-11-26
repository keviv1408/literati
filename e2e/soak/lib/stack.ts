import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { failure } from './fail';
import { BACKEND_URL, FRONTEND_URL, READY_TIMEOUT_MS, STANDIN_URL } from './limits';

export type DbMode = 'standin' | 'real';

export interface Stack {
  mode: DbMode;
  backendLog: string;
  killBackend(): Promise<void>;
  startBackend(): Promise<void>;
  standinReport(): Promise<{ unknown: string[]; refused: string[] }>;
  backendLogTail(lines: number): string;
  stop(): Promise<void>;
}

const BACKEND_DIR = path.resolve(__dirname, '../../../backend');
const STANDIN_SCRIPT = path.resolve(__dirname, '../standin.js');
// Every child is started with this preload and a stdin pipe, so it dies with the test worker even when Playwright SIGKILLs it.
const LEASH = path.resolve(__dirname, '../leash.js');
const BACKEND_PORT = Number(new URL(BACKEND_URL).port);
const FRONTEND_PORT = Number(new URL(FRONTEND_URL).port);
const STANDIN_PORT = Number(new URL(STANDIN_URL).port);
const PROBE_MS = 1_000;
const POLL_MS = 100;
const STOP_BACKEND = 'Stop the dev backend first. Kill the nodemon parent too.';

export function backendEnv(mode: DbMode): NodeJS.ProcessEnv {
  const env = { ...process.env, PORT: String(BACKEND_PORT), NODE_ENV: 'development' };
  // Variables set on the process win over backend/.env, so real mode sets none of Supabase's.
  if (mode === 'real') return env;
  return { ...env, SUPABASE_URL: STANDIN_URL, SUPABASE_SERVICE_ROLE_KEY: 'standin' };
}

export async function killChildren(children: ChildProcess[]): Promise<void> {
  // The signals go out before the first await, so a process 'exit' handler can use this too.
  await Promise.all(
    children.map((child) => {
      const exited = _exited(child);
      if (_alive(child)) child.kill('SIGKILL');
      return exited;
    }),
  );
}

export async function startStack(mode: DbMode, outDir: string): Promise<Stack> {
  await _checkPorts(mode);
  mkdirSync(outDir, { recursive: true });
  const backendLog = path.join(outDir, 'backend.log');
  let standin: ChildProcess | null = null;
  let standinGone: string | null = null;
  let backend: ChildProcess | null = null;
  const children = () => [standin, backend].filter((child): child is ChildProcess => child !== null);
  // A dead stand-in otherwise shows up as a bare `fetch failed` or as room 500s.
  const checkStandin = () => {
    if (standinGone) throw failure(`the stand-in died (${standinGone})`);
  };
  const onDeath = () => void killChildren(children());
  process.on('exit', onDeath);
  process.on('SIGINT', onDeath);
  process.on('SIGTERM', onDeath);

  const stack: Stack = {
    mode,
    backendLog,

    async killBackend() {
      if (backend) await killChildren([backend]);
      if (!(await _poll(async () => !(await _answers(BACKEND_PORT)), READY_TIMEOUT_MS))) {
        throw failure(`port ${BACKEND_PORT} still answers after the backend was killed`);
      }
    },

    async startBackend() {
      checkStandin();
      if (backend && _alive(backend)) throw failure('the soak backend is already running');
      if (await _answers(BACKEND_PORT)) throw failure(STOP_BACKEND);
      const log = openSync(backendLog, 'a');
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, ['--require', LEASH, 'src/index.js'], {
          cwd: BACKEND_DIR,
          env: backendEnv(mode),
          stdio: ['pipe', log, log],
        });
      } finally {
        closeSync(log);
      }
      backend = child;
      let spawnError = null as Error | null;
      child.on('error', (err) => (spawnError = err));
      const settled = await _poll(async () => !_alive(child) || (await _healthy()), READY_TIMEOUT_MS);
      if (spawnError) throw failure(`the backend did not start: ${spawnError.message}`);
      if (!_alive(child)) throw failure(`the backend exited before it was ready\n${stack.backendLogTail(20)}`);
      if (!settled) throw failure(`the backend was not ready within ${READY_TIMEOUT_MS / 1000} s\n${stack.backendLogTail(20)}`);
    },

    async standinReport() {
      if (mode === 'real') return { unknown: [], refused: [] };
      checkStandin();
      let res: Response;
      try {
        res = await fetch(`${STANDIN_URL}/__standin/report`);
      } catch (err) {
        checkStandin();
        throw err;
      }
      return res.json();
    },

    backendLogTail(lines) {
      const text = existsSync(backendLog) ? readFileSync(backendLog, 'utf8').trimEnd() : '';
      return ['--- backend.log ---', ...(text ? text.split('\n').slice(-lines) : [])].join('\n');
    },

    async stop() {
      await killChildren(children());
      process.off('exit', onDeath);
      process.off('SIGINT', onDeath);
      process.off('SIGTERM', onDeath);
    },
  };

  try {
    if (mode === 'standin') {
      standin = spawn(process.execPath, ['--require', LEASH, STANDIN_SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] });
      standin.once('exit', (code, signal) => (standinGone = signal ?? `exit code ${code}`));
      await _standinReady(standin);
    }
    await stack.startBackend();
  } catch (err) {
    await stack.stop();
    throw err;
  }
  return stack;
}

async function _checkPorts(mode: DbMode): Promise<void> {
  if (await _answers(BACKEND_PORT)) throw failure(STOP_BACKEND);
  if (!(await _answers(FRONTEND_PORT))) throw failure('Start the frontend on 3011.');
  if (mode === 'standin' && (await _answers(STANDIN_PORT))) throw failure('Port 54321 is taken. The stand-in needs it.');
}

// Both loopback families: a server bound to only one of them still owns the port for whoever resolves localhost to it.
async function _answers(port: number): Promise<boolean> {
  const hits = await Promise.all(['127.0.0.1', '::1'].map((host) => _connects(host, port)));
  return hits.includes(true);
}

function _connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: PROBE_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    // A listener too busy to accept in time still holds the port.
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function _healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(PROBE_MS) });
    await res.arrayBuffer();
    return res.status === 200;
  } catch {
    return false;
  }
}

async function _poll(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

function _standinReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(
      () => reject(failure(`the stand-in was not ready within ${READY_TIMEOUT_MS / 1000} s`)),
      READY_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      out += chunk;
      if (!out.includes('standin ready')) return;
      child.stdout!.off('data', onData).resume();
      clearTimeout(timer);
      resolve();
    };
    child.stdout!.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(failure(`the stand-in did not start: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(failure(`the stand-in exited (${signal ?? code}) before it was ready`));
    });
  });
}

function _alive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function _exited(child: ChildProcess): Promise<void> {
  if (!_alive(child)) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
