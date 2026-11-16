// Runs server/index.js as Claude Desktop would — a child process speaking
// newline-delimited JSON-RPC on stdin/stdout — and keeps everything it says.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portRange, randomBase, requestProblems } from './fakeSpredin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const SERVER = path.join(REPO, 'server', 'index.js');
const SPY = path.join(HERE, 'netspy.cjs');

export function tempDir(prefix = 'spredin-connector-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const running = new Set();

/** Kill every connector still running (a test that failed early leaves them). */
export async function killAll() {
  await Promise.all([...running].map((c) => c.kill()));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start the connector in test mode (SPREDIN_CONNECTOR_TEST=1, so the hooks
 * count). `ports` is the SPREDIN_CONNECTOR_PORTS value (by default an empty
 * random block, never Spredin's real ports, so a real Spredin on this Mac is
 * never touched). HOME points into a temp folder too. `test: false` leaves
 * the test flag out (the hooks must then be ignored).
 */
export function startConnector({ ports, env = {}, pairingFile, node = process.execPath, test = true } = {}) {
  const dir = tempDir();
  const file = pairingFile ?? path.join(dir, 'Spredin Connector', 'pairing.json');
  const spyFile = path.join(dir, 'net.jsonl');
  const child = spawn(node, ['--require', SPY, SERVER], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      APPDATA: dir,
      NETSPY_FILE: spyFile,
      SPREDIN_CONNECTOR_PAIRING_FILE: file,
      SPREDIN_CONNECTOR_PORTS: ports ?? portRange(randomBase()),
      ...(test ? { SPREDIN_CONNECTOR_TEST: '1' } : {}),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = [];
  const badLines = [];
  const messages = [];
  const waiters = [];
  let stderr = '';
  let out = '';
  let nextId = 1000;

  const offer = (msg) => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        badLines.push(line);
        continue;
      }
      const items = Array.isArray(msg) ? msg : [msg];
      for (const m of items) {
        if (m === null || typeof m !== 'object' || m.jsonrpc !== '2.0') badLines.push(line);
        messages.push(m);
        offer(m);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  exited.then(() => running.delete(api));

  const api = {
    child,
    dir,
    pairingFile: file,
    messages,
    lines,
    badLines,
    get stderr() {
      return stderr;
    },
    sendLine(line) {
      child.stdin.write(line + '\n');
    },
    send(msg) {
      api.sendLine(JSON.stringify(msg));
    },
    waitFor(pred, timeoutMs = 10_000, what = 'a message') {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === resolve);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${what}; got:\n${lines.join('\n')}\nstderr:\n${stderr}`));
        }, timeoutMs);
        waiters.push({ pred, resolve, timer });
      });
    },
    /** Send a request and wait for the response with its id. */
    request(method, params, { id = nextId++, timeoutMs = 10_000 } = {}) {
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      api.send(msg);
      return api.waitFor((m) => m.id === id && ('result' in m || 'error' in m), timeoutMs, `the answer to ${method} #${id}`);
    },
    notify(method, params) {
      const msg = { jsonrpc: '2.0', method };
      if (params !== undefined) msg.params = params;
      api.send(msg);
    },
    /** Legacy handshake, as Claude Desktop does it today. */
    async initialize(clientInfo = { name: 'claude-ai', version: '0.14.2' }, protocolVersion = '2025-11-25') {
      const r = await api.request('initialize', { protocolVersion, capabilities: {}, clientInfo });
      api.notify('notifications/initialized');
      return r;
    },
    call(name, args = {}, opts) {
      return api.request('tools/call', { name, arguments: args }, opts);
    },
    notifications(method) {
      return messages.filter((m) => m.method === method && !('id' in m));
    },
    /** Every connection and lookup the process made (from the --require spy). */
    net() {
      if (!fs.existsSync(spyFile)) return [];
      return fs
        .readFileSync(spyFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    /** Close stdin, wait for exit; returns what a test should check at the end. */
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
      const how = await exited;
      clearTimeout(timer);
      if (out.trim()) badLines.push(out);
      return how;
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return exited;
    },
  };
  running.add(api);
  return api;
}

/** A pairing file, as the connector writes one. */
export function writePairing(c, { token, id }) {
  fs.mkdirSync(path.dirname(c.pairingFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(c.pairingFile, JSON.stringify({ token, id, paired: new Date().toISOString() }), { mode: 0o600 });
}

/**
 * A stand-in for /usr/sbin/lsof (SPREDIN_CONNECTOR_LSOF, test mode only):
 * a shell script that records its arguments to `<path>.args` and then runs
 * `body` (e.g. 'exit 1', or 'echo p123').
 */
export function fakeLsof(body) {
  const dir = tempDir('spredin-lsof-');
  const file = path.join(dir, 'lsof');
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${file}.args"\n${body}\n`, { mode: 0o755 });
  return { file, args: () => (fs.existsSync(`${file}.args`) ? fs.readFileSync(`${file}.args`, 'utf8').trim().split('\n') : null) };
}

export function textOf(response) {
  return (response.result?.content ?? []).map((c) => c.text).join('\n');
}

/**
 * The checks every connector test ends with: stdout held nothing but
 * JSON-RPC lines; the process only connected to 127.0.0.1 and looked up no
 * host name; no request carried an Origin header; no token reached stderr;
 * and it exited cleanly when stdin closed.
 */
export async function finish(assert, c, fakes = [], impostors = []) {
  const how = await c.close();
  assert.deepEqual(c.badLines, [], 'stdout must carry only JSON-RPC messages, one per line');
  const tokens = new Set(fakes.flatMap((f) => [...f.state.tokens]));
  for (const fake of fakes) {
    assert.deepEqual(fake.problems(), [], 'every request: no Origin or Sec-Fetch-*, X-Spredin-Connector: 1, Host 127.0.0.1:<port>, no token');
  }
  for (const imp of impostors) {
    assert.deepEqual(requestProblems(imp.requests, imp.port, tokens), [], 'an impostor is sent no token and nothing a web page would send');
  }
  for (const token of tokens) {
    assert.ok(!c.stderr.includes(token), 'the token must never be logged');
    assert.ok(!c.lines.some((l) => l.includes(token)), 'the token must never reach Claude');
  }
  assert.ok(!/x-spredin-mac|[0-9a-f]{64}/i.test(c.stderr), 'no MAC or key in the log');
  const net = c.net();
  const lookups = net.filter((r) => r.lookup !== undefined);
  assert.deepEqual(lookups, [], 'no host name is ever looked up');
  const elsewhere = net.filter((r) => r.connect && r.host !== '127.0.0.1');
  assert.deepEqual(elsewhere, [], 'every connection goes to 127.0.0.1');
  assert.equal(how.code, 0, `exit code (signal ${how.signal}); stderr:\n${c.stderr}`);
  return net;
}
