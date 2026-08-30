'use strict';

// Render's proxy never forwards server-initiated close frames, so the browser
// would keep a dead socket that still looks OPEN. Announce the close as a
// message first; the client closes from its side, which does get through.
function closeWithNotice(ws, code, reason) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send?.(JSON.stringify({ type: 'closing', code, reason }));
  }
  ws.close?.(code, reason);
}

module.exports = { closeWithNotice };
