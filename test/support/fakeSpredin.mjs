// A stand-in for Spredin Pro's side of PROTOCOL.md, for the tests.
//
// Listens on 127.0.0.1 only. Refuses (403) a request with an Origin or a
// Sec-Fetch-* header, without X-Spredin-Connector: 1, or with a Host that is
// not 127.0.0.1:<port> / localhost:<port>. POST /pair checks the code and
// issues a token; POST /mcp checks the signature (key = SHA-256(token), its
// own port inside the MAC, a time near its clock, a nonce it has not seen)
// and signs its answer. Every request is recorded so a test can check what
// was sent.
import http from 'node:http';
import crypto from 'node:crypto';

export const FAKE_TOOLS = [
  { name: 'describe_sheet', description: 'Live describe_sheet', inputSchema: { type: 'object', properties: { sheet: { type: 'string' } } } },
  { name: 'fake_only', description: 'A tool only the fake Spredin has', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_workbooks', description: 'Live list_workbooks', inputSchema: { type: 'object', properties: {} } },
  { name: 'use_workbook', description: 'Live use_workbook', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const PAIR_ANSWERS = {
  decline: [403, 'declined', 'The person said no.'],
  timeout: [408, 'timeout', 'Nobody answered.'],
  busy: [409, 'busy', 'Another request is being asked.'],
  wait: [429, 'wait', 'Declined a moment ago.'],
  'no-window': [503, 'no-window', 'No workbook window is open.'],
  stopped: [503, 'stopped', 'The connector was turned off.'],
  'bad-request': [400, 'bad-request', 'The body is not the JSON above.'],
};

export const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const keyOf = (token) => crypto.createHash('sha256').update(token, 'utf8').digest();
export const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
export const reqMac = (key, port, id, time, nonce, body) => hmac(key, `req\n${port}\n${id}\n${time}\n${nonce}\n${sha256hex(body)}`);
export const resMac = (key, port, nonce, status, body) => hmac(key, `res\n${port}\n${nonce}\n${status}\n${sha256hex(body)}`);

const open = new Set();

/** Close every fake and impostor still open (a test that failed early leaves them). */
export async function closeAllFakes() {
  await Promise.all([...open].map((f) => f.close()));
}

/** A random base for a block of 8 ports, away from Spredin's real 41870–41877. */
export function randomBase() {
  for (;;) {
    const base = 20000 + Math.floor(Math.random() * 35000);
    if (base + 8 < 41870 || base > 41877) return base;
  }
}

export function portRange(base) {
  return `${base}-${base + 7}`;
}

function send(res, status, bytes, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, ...headers });
  res.end(bytes);
}
const json = (res, status, body, headers) => send(res, status, Buffer.from(body === undefined ? '' : JSON.stringify(body)), headers);

/** The checks Spredin makes of every request: no web page, the header, its own Host. */
function refusedAtTheDoor(req, port) {
  if (req.headers.origin !== undefined) return 'origin';
  if (Object.keys(req.headers).some((h) => h.startsWith('sec-fetch-'))) return 'sec-fetch';
  if (req.headers['x-spredin-connector'] !== '1') return 'no connector header';
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return 'host';
  return null;
}

async function readAll(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function listen(handler, port) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

/**
 * Start a fake Spredin. `port` fixes the port; otherwise it takes
 * `base + offset` of a random block (retrying on a clash) and reports `range`.
 */
export async function startFakeSpredin(opts = {}) {
  const state = {
    app: opts.app ?? 'Spredin Pro',
    connector: opts.connector ?? 1,
    version: opts.version ?? '1.0.4',
    pair: opts.pair ?? 'allow', // allow | decline | … | hang | bad-token
    pairDelayMs: opts.pairDelayMs ?? 0,
    sign: opts.sign ?? 'good', // good | none | bad: how answers are signed
    tools: opts.tools ?? FAKE_TOOLS,
    onCall:
      opts.onCall ??
      (async (name, args) => ({ content: [{ type: 'text', text: `called ${name} ${JSON.stringify(args)}` }], isError: false })),
    pairings: new Map(), // id → { token, key }
    tokens: new Set(), // every token ever issued (for the "never sent, never logged" checks)
    nonces: new Set(),
    requests: [],
    codes: [],
    pairCount: 0,
  };
  let port;
  let server;

  const addPairing = () => {
    const token = crypto.randomBytes(32).toString('hex');
    const id = `pairing-${state.pairings.size + 1}-${crypto.randomBytes(3).toString('hex')}`;
    state.pairings.set(id, { token, key: keyOf(token) });
    state.tokens.add(token);
    return { token, id };
  };

  const handler = async (req, res) => {
    const raw = await readAll(req);
    const rec = { method: req.method, url: req.url, headers: { ...req.headers }, body: raw.toString('utf8'), remote: req.socket.remoteAddress, aborted: false };
    try {
      rec.json = raw.length ? JSON.parse(rec.body) : undefined;
    } catch {
      rec.json = undefined;
    }
    state.requests.push(rec);
    res.on('close', () => {
      if (!res.writableFinished) rec.aborted = true;
    });

    const refused = refusedAtTheDoor(req, port);
    if (refused) return json(res, 403, { error: 'forbidden', message: refused });

    if (req.method === 'GET' && req.url === '/spredin') return json(res, 200, { app: state.app, connector: state.connector, version: state.version });

    if (req.method === 'POST' && req.url === '/pair') {
      state.pairCount += 1;
      if (!rec.json || !CODE_RE.test(rec.json.code ?? '')) return json(res, 400, { error: 'bad-request', message: 'No valid code.' });
      state.codes.push(rec.json.code);
      if (state.pair === 'hang') return; // never answers
      if (state.pairDelayMs) await new Promise((r) => setTimeout(r, state.pairDelayMs));
      if (res.destroyed) return;
      if (state.pair === 'allow') return json(res, 200, addPairing());
      if (state.pair === 'bad-token') return json(res, 200, { token: 'not-a-token', id: 'x' });
      const [status, error, message] = PAIR_ANSWERS[state.pair];
      return json(res, status, { error, message });
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      const id = req.headers['x-spredin-pairing'];
      const time = req.headers['x-spredin-time'];
      const nonce = req.headers['x-spredin-nonce'];
      const mac = req.headers['x-spredin-mac'];
      const pairing = state.pairings.get(id);
      rec.macOk =
        !!pairing &&
        /^[0-9a-f]{32}$/.test(nonce ?? '') &&
        Math.abs(Date.now() - Number(time)) <= 120_000 &&
        mac === reqMac(pairing.key, port, id, time, nonce, raw) &&
        !state.nonces.has(nonce);
      if (!rec.macOk) return json(res, 401, { error: 'unpaired', message: 'Pair again.' }); // unsigned, as Spredin's
      state.nonces.add(nonce);
      const answer = (status, bytes) => {
        const headers = {};
        if (state.sign === 'good') headers['X-Spredin-Mac'] = resMac(pairing.key, port, nonce, status, bytes);
        if (state.sign === 'bad') headers['X-Spredin-Mac'] = resMac(pairing.key, port + 1, nonce, status, bytes);
        send(res, status, bytes, headers);
      };
      const msg = rec.json;
      if (!msg) return answer(400, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })));
      if (msg.id === undefined) return answer(202, Buffer.alloc(0));
      let result;
      if (msg.method === 'tools/list') result = { tools: state.tools };
      else if (msg.method === 'ping') result = {};
      else if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params ?? {};
        if (name === 'no_such_tool') {
          return answer(200, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool: no_such_tool' } })));
        }
        result = await state.onCall(name, args, rec);
        if (res.destroyed) return;
      } else return answer(200, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })));
      return answer(200, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })));
    }

    json(res, 404, { error: 'not-found', message: 'No such path.' });
  };

  let base = opts.base;
  const offset = opts.offset ?? 0;
  for (let tries = 0; ; tries++) {
    const b = base ?? randomBase();
    port = opts.port ?? b + offset;
    try {
      server = await listen(handler, port);
      base = opts.port ? undefined : b;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || opts.port || opts.base || tries > 20) throw e;
    }
  }

  const fake = {
    port,
    base,
    range: base === undefined ? `${port}` : portRange(base),
    state,
    /** A pairing made earlier (as if the person had allowed it before). */
    addPairing,
    /** Disconnect in Spredin: every pairing forgotten. */
    disconnectAll() {
      state.pairings.clear();
    },
    /** Every request: no Origin or Sec-Fetch-*, the connector header, Host 127.0.0.1:<port>, no token. */
    problems() {
      return requestProblems(state.requests, port, state.tokens);
    },
    count(method, url) {
      return state.requests.filter((r) => r.method === method && r.url === url).length;
    },
    calls() {
      return state.requests.filter((r) => r.url === '/mcp' && r.json?.method === 'tools/call');
    },
    mcp() {
      return state.requests.filter((r) => r.url === '/mcp');
    },
    cancellations() {
      return state.requests.filter((r) => r.url === '/mcp' && r.json?.method === 'notifications/cancelled');
    },
    async close() {
      open.delete(fake);
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
  open.add(fake);
  return fake;
}

export function requestProblems(requests, port, tokens = new Set()) {
  const out = [];
  for (const r of requests) {
    const where = `${r.method} ${r.url} on ${port}`;
    if (r.headers.origin !== undefined) out.push(`${where} carried Origin`);
    if (Object.keys(r.headers).some((h) => h.startsWith('sec-fetch-'))) out.push(`${where} carried Sec-Fetch-*`);
    if (r.headers['x-spredin-connector'] !== '1') out.push(`${where} had no X-Spredin-Connector: 1`);
    if (r.headers.authorization !== undefined) out.push(`${where} carried Authorization`);
    if (r.headers.host !== `127.0.0.1:${port}`) out.push(`${where} had Host ${r.headers.host}`);
    if (r.remote !== '127.0.0.1' && r.remote !== '::ffff:127.0.0.1') out.push(`${where} came from ${r.remote}`);
    const seen = JSON.stringify(r.headers) + r.body;
    for (const t of tokens) if (seen.includes(t)) out.push(`${where} carried a pairing token`);
  }
  return out;
}

/**
 * Something else on a port that answers GET /spredin as Spredin does — but
 * is not Spredin. `kind`:
 *   other     says it is another app;
 *   unsigned  answers /mcp and /pair, with no signature;
 *   badsig    answers /mcp with a signature that is not Spredin's;
 *   refuse    answers every /mcp with 401;
 *   relay     passes /mcp on, unchanged, to `target` (the real Spredin's port).
 */
export async function startImpostor(port, kind = 'other', target) {
  const requests = [];
  const handler = async (req, res) => {
    const raw = await readAll(req);
    let parsed;
    try {
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      parsed = undefined;
    }
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: raw.toString('utf8'), json: parsed, remote: req.socket.remoteAddress });
    if (req.url === '/spredin') {
      return kind === 'other' ? json(res, 200, { app: 'Something Else', version: '9' }) : json(res, 200, { app: 'Spredin Pro', connector: 1, version: '1.0.4' });
    }
    if (kind === 'refuse') return json(res, 401, { error: 'unpaired', message: 'Pair again.' });
    if (req.url === '/pair') return json(res, 200, { token: 'f'.repeat(64), id: 'impostor' });
    if (kind === 'relay') {
      const headers = { ...req.headers };
      delete headers['content-length'];
      const r = await new Promise((resolve, reject) => {
        const out = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: { ...headers, host: `127.0.0.1:${target}` } }, (back) => {
          const chunks = [];
          back.on('data', (c) => chunks.push(c));
          back.on('end', () => resolve({ status: back.statusCode, headers: back.headers, body: Buffer.concat(chunks) }));
        });
        out.on('error', reject);
        out.end(raw);
      });
      requests[requests.length - 1].relayedStatus = r.status;
      const back = {};
      if (r.headers['x-spredin-mac']) back['X-Spredin-Mac'] = r.headers['x-spredin-mac'];
      return send(res, r.status, r.body, back);
    }
    const msg = (() => {
      try {
        return JSON.parse(raw.toString('utf8'));
      } catch {
        return {};
      }
    })();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: { content: [{ type: 'text', text: 'IMPOSTOR' }], isError: false, tools: [] } }));
    const headers = kind === 'badsig' ? { 'X-Spredin-Mac': crypto.randomBytes(32).toString('hex') } : {};
    send(res, 200, body, headers);
  };
  const server = await listen(handler, port);
  const impostor = {
    port,
    requests,
    close: () =>
      new Promise((r) => {
        open.delete(impostor);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
  open.add(impostor);
  return impostor;
}
