import { backoffDelayMs } from '@/lib/backoff';

export const HEARTBEAT_DEAD_MS = 35_000;
export const RESUME_STALE_MS = 20_000;

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';
export type DropCause = 'close' | 'heartbeat';
export interface SocketDrop { closeCode: number | null; detectedBy: DropCause }
export interface ReconnectingSocketOptions {
  getUrl: () => string;
  onMessage: (msg: Record<string, unknown>) => void;
  onStatus: (status: SocketStatus, stop?: { code: number; reason: string }) => void;
  onDrop?: (drop: SocketDrop) => void;
}
export interface ReconnectingSocket {
  send(payload: unknown): boolean;
  confirm(): void;
  retryNow(): void;
  retryWithNewCredentials(): void;
  close(): void;
}

const _SERVER_ERROR_CODE = 4500;

function _isStopCode(code: number): boolean {
  return code >= 4000 && code <= 4999 && code !== _SERVER_ERROR_CODE;
}

function _parse(data: unknown): Record<string, unknown> | null {
  try {
    const msg: unknown = JSON.parse(data as string);
    return typeof msg === 'object' && msg !== null ? (msg as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createReconnectingSocket(options: ReconnectingSocketOptions): ReconnectingSocket {
  const { getUrl, onMessage, onStatus, onDrop } = options;
  let current: WebSocket | null = null;
  let confirmed = false;
  let armed = false;
  let lastMessageAt = 0;
  let failures = 0;
  let status: SocketStatus | null = null;
  let stopped = false;
  let unauthorized = false;
  let handshakeUrl = '';
  let wait: ReturnType<typeof setTimeout> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined;

  function setStatus(next: SocketStatus, stop?: { code: number; reason: string }) {
    if (next === status) return;
    status = next;
    onStatus(next, stop);
  }

  function connect() {
    wait = undefined;
    let ws: WebSocket;
    try {
      unauthorized = false;
      handshakeUrl = getUrl();
      ws = new WebSocket(handshakeUrl);
    } catch {
      teardown();
      setStatus('error');
      return;
    }
    current = ws;
    ws.onmessage = (event: MessageEvent) => {
      if (ws === current) receive(event.data);
    };
    ws.onclose = (event: CloseEvent) => {
      if (ws !== current) return;
      detach();
      drop(event.code, event.reason, 'close');
    };
  }

  function receive(data: unknown) {
    lastMessageAt = Date.now();
    const msg = _parse(data);
    if (msg?.type === 'heartbeat') armed = true;
    if (armed) {
      clearTimeout(silence);
      silence = setTimeout(onSilence, HEARTBEAT_DEAD_MS);
    }
    if (!msg || msg.type === 'heartbeat') return;
    if (msg.type === 'closing') {
      const { code, reason = '' } = msg as { code: number; reason?: string };
      detach()?.close(1000);
      drop(code, reason, 'close');
      return;
    }
    onMessage(msg);
  }

  function onSilence() {
    detach()?.close(1000);
    drop(null, '', 'heartbeat');
  }

  // Detach before closing from our side, so the socket's own close handler sees a stale socket and ignores it.
  function detach(): WebSocket | null {
    const ws = current;
    current = null;
    armed = false;
    clearTimeout(silence);
    return ws;
  }

  function drop(code: number | null, reason: string, detectedBy: DropCause) {
    if (code === 4001) {
      confirmed = false;
      unauthorized = true;
      setStatus('error', { code, reason });
      retryWithNewCredentials();
      return;
    }
    if (code !== null && _isStopCode(code)) {
      teardown();
      setStatus('error', { code, reason });
      return;
    }
    const wasConfirmed = confirmed;
    confirmed = false;
    if (wasConfirmed) onDrop?.({ closeCode: code, detectedBy });
    setStatus('reconnecting');
    // A callback above may have called close().
    if (stopped) return;
    if (detectedBy === 'heartbeat') connect();
    else wait = setTimeout(connect, backoffDelayMs(failures++));
  }

  function retryNow() {
    if (wait === undefined) return;
    clearTimeout(wait);
    connect();
  }

  function retryWithNewCredentials() {
    if (stopped || !unauthorized || getUrl() === handshakeUrl) return;
    setStatus('connecting');
    connect();
  }

  function wake() {
    if (current && armed && Date.now() - lastMessageAt > RESUME_STALE_MS) onSilence();
    else retryNow();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') wake();
  }

  function teardown() {
    stopped = true;
    clearTimeout(wait);
    clearTimeout(silence);
    wait = undefined;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', wake);
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', wake);
  setStatus('connecting');
  connect();

  return {
    send(payload) {
      if (!confirmed || !current || current.readyState !== WebSocket.OPEN) return false;
      current.send(JSON.stringify(payload));
      return true;
    },
    confirm() {
      if (!current) return;
      confirmed = true;
      failures = 0;
      setStatus('connected');
    },
    retryNow,
    retryWithNewCredentials,
    close() {
      teardown();
      detach()?.close(1000);
    },
  };
}
