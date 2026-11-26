import type { Page, WebSocketRoute } from '@playwright/test';

export const CUT = { code: 3001, reason: 'e2e cut' };

export type Msg = { type: string; [key: string]: any };

export interface Frame {
  at: number;
  msg: Msg;
}

export interface Closed {
  by: 'page' | 'server';
  code: number;
  reason: string;
  at: number;
}

export interface GameSocket {
  index: number;
  openedAt: number;
  page: WebSocketRoute;
  server: WebSocketRoute | null;
  cut: boolean;
  closed: Closed | null;
  frames: Frame[];
}

export interface Wire {
  sockets: GameSocket[];
  refusing: boolean;
}

export async function routeGameSocket(page: Page): Promise<Wire> {
  const wire: Wire = { sockets: [], refusing: false };
  await page.routeWebSocket(/\/ws\/game\//, (ws) => {
    const socket: GameSocket = {
      index: wire.sockets.length,
      openedAt: Date.now(),
      page: ws,
      server: null,
      cut: false,
      closed: null,
      frames: [],
    };
    wire.sockets.push(socket);
    if (wire.refusing) {
      socket.closed = { by: 'server', code: 1006, reason: 'refused', at: Date.now() };
      void ws.close({ code: 1006, reason: 'refused' });
      return;
    }
    const server = ws.connectToServer();
    socket.server = server;
    // A message handler on each side turns off auto-forwarding, so a cut can stop the traffic.
    ws.onMessage((message) => {
      if (!socket.cut) server.send(message);
    });
    server.onMessage((message) => {
      if (socket.cut) return;
      socket.frames.push({ at: Date.now(), msg: JSON.parse(String(message)) });
      ws.send(message);
    });
    // A close handler turns off close forwarding too, so _onClose passes each close on by hand.
    ws.onClose((code, reason) => _onClose(socket, 'page', server, code, reason));
    server.onClose((code, reason) => _onClose(socket, 'server', ws, code, reason));
  });
  return wire;
}

function _onClose(socket: GameSocket, by: Closed['by'], other: WebSocketRoute, code?: number, reason?: string) {
  if (socket.cut) return;
  // 1005 is what a browser reports for a close that carried no code.
  socket.closed ??= { by, code: code ?? 1005, reason: reason ?? '', at: Date.now() };
  void other.close({ code, reason });
}

export async function cut(socket: GameSocket, sides: 'both' | 'server') {
  // Mark first, so the close handlers neither record nor forward the closes the cut makes.
  socket.cut = true;
  await socket.server!.close(CUT);
  if (sides === 'both') await socket.page.close(CUT);
}

export function findFrame(socket: GameSocket, type: string, match: (msg: Msg) => boolean = () => true) {
  return socket.frames.find((frame) => frame.msg.type === type && match(frame.msg));
}
