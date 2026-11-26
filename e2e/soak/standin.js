const http = require('node:http');
const { randomUUID } = require('node:crypto');

const PORT = 54321;
const ROOM_COLUMNS = [
  'id', 'code', 'invite_code', 'spectator_token', 'host_user_id', 'host_guest_id', 'player_count',
  'card_removal_variant', 'status', 'game_state', 'is_matchmaking', 'created_at', 'updated_at',
];
const STATUSES = ['waiting', 'starting', 'in_progress', 'completed', 'cancelled', 'abandoned'];
const VARIANTS = ['remove_2s', 'remove_7s', 'remove_8s'];
const NOT_NULL = ROOM_COLUMNS.filter((c) => !['host_user_id', 'host_guest_id', 'game_state'].includes(c));
const UNIQUE = ['id', 'code', 'invite_code', 'spectator_token'];
const UUID_COLUMNS = ['id', 'host_user_id', 'host_guest_id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINGLE = 'application/vnd.pgrst.object+json';
const PREFER = ['return=representation', 'return=minimal', 'missing=default'];

function _error(status, code, message, details = null) {
  return Object.assign(new Error(message), { status, body: { code, details, hint: null, message } });
}

function _unknown(what) {
  return _error(501, 'STANDIN', `the stand-in does not serve ${what}`);
}

function _column(name) {
  if (!ROOM_COLUMNS.includes(name)) throw _error(400, '42703', `column rooms.${name} does not exist`);
  return name;
}

function _text(value) {
  if (value === null) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function _filter(column, expr) {
  const [, op, arg] = /^([a-z]+)\.(.*)$/s.exec(expr) ?? [];
  if (op === 'eq') return (row) => _text(row[column]) === arg;
  if (op === 'in' && /^\(.*\)$/s.test(arg)) {
    const values = [...arg.slice(1, -1).matchAll(/"([^"]*)"|([^,]+)/g)].map((m) => m[1] ?? m[2]);
    return (row) => values.includes(_text(row[column]));
  }
  throw _unknown(`the filter ${column}=${op}`);
}

function _query(url, method) {
  const q = { columns: ROOM_COLUMNS, filters: [], order: [], limit: null };
  for (const [key, value] of url.searchParams) {
    if (key === 'select') q.columns = value.split(',').flatMap((c) => (c === '*' ? ROOM_COLUMNS : [_column(c)]));
    else if (key === 'limit' && method === 'GET') q.limit = Number(value);
    else if (key === 'order' && method === 'GET') {
      q.order = value.split(',').map((term) => {
        const [column, dir, ...rest] = term.split('.');
        if (!['asc', 'desc'].includes(dir) || rest.length) throw _unknown(`the order ${term}`);
        return { column: _column(column), desc: dir === 'desc' };
      });
    } else if (ROOM_COLUMNS.includes(key) && method !== 'POST') q.filters.push(_filter(key, value));
    else throw _unknown(`the parameter ${key} on ${method}`);
  }
  return q;
}

// Postgres sorts nulls as larger than any value: last ascending, first descending.
function _compare(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function createStandin() {
  const rows = [];
  const unknown = [];
  const refused = [];
  let lastStamp = 0;

  // Postgres stamps in microseconds; whole milliseconds would tie on back-to-back writes.
  function _now() {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  }

  function _checkKeys(values) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw _error(400, 'PGRST102', 'Empty or invalid json');
    }
    for (const key of Object.keys(values)) {
      if (!ROOM_COLUMNS.includes(key)) {
        throw _error(400, 'PGRST204', `Could not find the '${key}' column of 'rooms' in the schema cache`);
      }
    }
  }

  function _checkRow(row, others) {
    for (const c of UUID_COLUMNS) {
      if (row[c] !== null && !UUID.test(row[c])) throw _error(400, '22P02', `invalid input syntax for type uuid in ${c}`);
    }
    if (row.status !== null && !STATUSES.includes(row.status)) {
      throw _error(400, '22P02', `invalid input value for enum room_status: "${row.status}"`);
    }
    if (row.card_removal_variant !== null && !VARIANTS.includes(row.card_removal_variant)) {
      throw _error(400, '22P02', `invalid input value for enum card_removal_variant: "${row.card_removal_variant}"`);
    }
    for (const c of NOT_NULL) {
      if (row[c] === null) throw _error(400, '23502', `null value in column "${c}" of relation "rooms" violates not-null constraint`);
    }
    if (![6, 8].includes(Number(row.player_count))) {
      throw _error(400, '23514', 'new row for relation "rooms" violates check constraint "rooms_player_count_check"');
    }
    if (row.host_user_id !== null && row.host_guest_id !== null) {
      throw _error(400, '23514', 'new row for relation "rooms" violates check constraint "rooms_one_host_kind"');
    }
    for (const c of UNIQUE) {
      if (others.some((o) => o[c] === row[c])) {
        throw _error(409, '23505', `duplicate key value violates unique constraint on rooms.${c}`, `Key (${c}) already exists.`);
      }
    }
  }

  function _insert(body) {
    const created = [];
    for (const values of Array.isArray(body) ? body : [body]) {
      _checkKeys(values);
      const stamp = _now();
      const row = {
        ...Object.fromEntries(ROOM_COLUMNS.map((c) => [c, null])),
        id: randomUUID(), status: 'waiting', is_matchmaking: false, created_at: stamp, updated_at: stamp,
        ...values,
      };
      _checkRow(row, [...rows, ...created]);
      created.push(row);
    }
    rows.push(...created);
    return created;
  }

  function _update(body, q) {
    _checkKeys(body);
    const targets = rows.filter((row) => q.filters.every((f) => f(row)));
    const stamp = _now();
    // The table's trigger sets updated_at on every update, whatever the request says.
    const next = targets.map((row) => ({ ...row, ...body, updated_at: stamp }));
    next.forEach((row, i) => _checkRow(row, rows.filter((o) => o !== targets[i])));
    targets.forEach((row, i) => Object.assign(row, next[i]));
    return targets;
  }

  function _select(q) {
    const found = rows.filter((row) => q.filters.every((f) => f(row)));
    found.sort((a, b) => {
      for (const { column, desc } of q.order) {
        const order = _compare(a[column], b[column]);
        if (order) return desc ? -order : order;
      }
      return 0;
    });
    return q.limit === null ? found : found.slice(0, q.limit);
  }

  function _body(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw _error(400, 'PGRST102', 'Empty or invalid json');
    }
  }

  function _rooms(req, url, raw) {
    const { method } = req;
    if (!['GET', 'POST', 'PATCH'].includes(method)) throw _unknown('this method');
    const prefer = (req.headers.prefer ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of prefer) if (!PREFER.includes(p)) throw _unknown(`Prefer: ${p}`);
    const q = _query(url, method);
    let found;
    if (method === 'GET') found = _select(q);
    else if (method === 'POST') found = _insert(_body(raw));
    else found = _update(_body(raw), q);

    const ok = method === 'POST' ? 201 : 200;
    if (method !== 'GET' && !prefer.includes('return=representation')) return [method === 'POST' ? 201 : 204];
    const data = found.map((row) => Object.fromEntries(q.columns.map((c) => [c, row[c]])));
    if (!(req.headers.accept ?? '').includes(SINGLE)) return [ok, data];
    if (data.length !== 1) {
      throw _error(406, 'PGRST116', 'Cannot coerce the result to a single JSON object', `The result contains ${data.length} rows`);
    }
    return [ok, data[0]];
  }

  function _route(req, url, raw) {
    const line = `${req.method} ${url.pathname}`;
    if (line === 'GET /__standin/report') return [200, { unknown, refused }];
    // auth-js turns a 401 with a JSON body into an error at once; GoTrue's own shape.
    if (line === 'GET /auth/v1/user') return [401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }];
    if (line === 'POST /rest/v1/rpc/mark_stale_games_abandoned') return [200, 0];
    if (url.pathname === '/rest/v1/rooms') return _rooms(req, url, raw);
    throw _unknown('this route');
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch {
      // The client died mid-request (a backend SIGKILL): Postgres would never see the statement.
      return;
    }
    const url = new URL(req.url, 'http://standin');
    let reply;
    try {
      reply = _route(req, url, Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      const status = err.status ?? 500;
      // The path only: query strings can hold spectator tokens.
      const line = `${req.method} ${url.pathname}: ${err.message}`;
      if (status === 501) unknown.push(line);
      else if (status === 400 || status === 500) refused.push(line);
      reply = [status, err.body ?? { code: 'STANDIN', details: null, hint: null, message: err.message }];
    }
    const [status, data] = reply;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  });

  return { server, rows, unknown, refused };
}

module.exports = { createStandin, ROOM_COLUMNS };

if (require.main === module) {
  createStandin().server.listen(PORT, '127.0.0.1', () => console.log('standin ready'));
}
