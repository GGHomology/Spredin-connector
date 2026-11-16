// The connector against a fake Spredin Pro (and impostors): discovery by
// signed answers, pairing with a code after the lsof check, signed requests,
// no pairing again by itself, connect_spredin, and what Claude is told.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFakeSpredin, startImpostor, closeAllFakes, portRange, randomBase, FAKE_TOOLS, keyOf, reqMac } from './support/fakeSpredin.mjs';
import { startConnector, finish, killAll, sleep, textOf, writePairing, fakeLsof, REPO } from './support/harness.mjs';
import { MESSAGES, formatCode } from '../server/connector.js';

afterEach(async () => {
  await killAll();
  await closeAllFakes();
});

const PACKAGED = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'tools.json'), 'utf8')).tools;
const CONNECT_TOOL = PACKAGED.find((t) => t.name === 'connect_spredin');
const LIVE = [...FAKE_TOOLS, CONNECT_TOOL];
const POSIX = process.platform !== 'win32';

async function until(pred, timeoutMs = 5_000, what = 'a condition') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const fileBytes = (c) => fs.readFileSync(c.pairingFile);
const readPairing = (c) => JSON.parse(fs.readFileSync(c.pairingFile, 'utf8'));
/** A pairing Spredin already knows, written as the connector would have. */
function seed(fake, c) {
  const p = fake.addPairing();
  writePairing(c, p);
  return p;
}

test('tools/list is the packaged list (and connect_spredin) when Spredin cannot be reached, and asks nothing of Spredin', async () => {
  const c = startConnector();
  await c.initialize();
  const r = await c.request('tools/list');
  assert.deepEqual(r.result.tools, PACKAGED);
  assert.ok(CONNECT_TOOL, 'connect_spredin is in the packaged list');
  assert.match(CONNECT_TOOL.description, /only when the user asks to connect or reconnect/);
  assert.deepEqual(c.net().filter((x) => x.connect), [], 'no pairing: tools/list does not even look for Spredin');
  writePairing(c, { token: crypto.randomBytes(32).toString('hex'), id: 'p1' });
  const again = await c.request('tools/list');
  assert.deepEqual(again.result.tools, PACKAGED, 'paired, but nothing listening: still the packaged list');
  await finish(assert, c);
});

test('a call when Spredin is not running says, plainly, how to reach it', async () => {
  const base = randomBase();
  const c = startConnector({ ports: portRange(base) });
  await c.initialize();
  const r = await c.call('read_range', { range: 'Sales!A1:B2' });
  assert.equal(r.result.isError, true);
  assert.equal(textOf(r), MESSAGES.unreachable);
  assert.equal(fs.existsSync(c.pairingFile), false, 'nothing is written without a pairing');
  const net = await finish(assert, c);
  const ports = [...new Set(net.filter((x) => x.connect).map((x) => x.port))].sort();
  assert.deepEqual(ports, Array.from({ length: 8 }, (_, i) => base + i), 'it asked every port of the block, and only those');
});

test('the first call pairs with a fresh code, keeps the token in a 0600 file, and signs every request', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  await c.initialize({ name: 'claude-ai', version: '0.14.2' });
  const r = await c.call('describe_sheet', { sheet: 'Sales' });
  assert.equal(r.result.isError, false, textOf(r));
  assert.equal(textOf(r), 'called describe_sheet {"sheet":"Sales"}');

  // POST /pair: the app's claim, who is asking, and a valid fresh code.
  const pair = fake.state.requests.find((q) => q.url === '/pair');
  assert.deepEqual(pair.json.client, { name: 'Claude', version: '0.14.2' });
  assert.deepEqual(pair.json.connector, { name: 'spredin-connector', version: '0.1.0' });
  assert.match(pair.json.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);

  // The pairing file: whole, this user's only.
  const saved = readPairing(c);
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'paired', 'token']);
  assert.ok(fake.state.tokens.has(saved.token));
  assert.ok(fake.state.pairings.has(saved.id));
  if (POSIX) {
    assert.equal(fs.statSync(c.pairingFile).mode & 0o777, 0o600, 'pairing.json is 0600');
    assert.equal(fs.statSync(path.dirname(c.pairingFile)).mode & 0o777, 0o700, 'its folder is 0700');
  }
  assert.deepEqual(fs.readdirSync(path.dirname(c.pairingFile)), ['pairing.json'], 'no temp file left behind');

  await c.call('find', { text: 'x' });
  // Every /mcp request is signed; the MAC is worked out here again from its parts.
  const mcp = fake.mcp();
  assert.ok(mcp.length >= 3, 'a signed ping, then the calls');
  const nonces = new Set();
  const key = keyOf(saved.token);
  for (const q of mcp) {
    assert.equal(q.headers['x-spredin-connector'], '1');
    assert.equal(q.headers['x-spredin-pairing'], saved.id);
    assert.match(q.headers['x-spredin-time'], /^\d+$/);
    assert.ok(Math.abs(Date.now() - Number(q.headers['x-spredin-time'])) < 60_000);
    assert.match(q.headers['x-spredin-nonce'], /^[0-9a-f]{32}$/);
    nonces.add(q.headers['x-spredin-nonce']);
    const want = reqMac(key, fake.port, saved.id, q.headers['x-spredin-time'], q.headers['x-spredin-nonce'], Buffer.from(q.body, 'utf8'));
    assert.equal(q.headers['x-spredin-mac'], want);
    assert.equal(q.macOk, true);
    assert.equal(q.headers.authorization, undefined);
    assert.ok(!q.body.includes(saved.token) && !JSON.stringify(q.headers).includes(saved.token), 'the token is never sent');
  }
  assert.equal(nonces.size, mcp.length, 'a fresh nonce every time');
  const [call] = fake.calls();
  assert.deepEqual(call.json.params, { name: 'describe_sheet', arguments: { sheet: 'Sales' } });
  assert.equal(fake.state.pairCount, 1);
  await finish(assert, c, [fake]);
});

test('a later process uses the saved pairing without asking again', async () => {
  const fake = await startFakeSpredin();
  const first = startConnector({ ports: fake.range });
  await first.initialize();
  await first.call('get_selection');
  await finish(assert, first, [fake]);
  const second = startConnector({ ports: fake.range, pairingFile: first.pairingFile });
  await second.initialize();
  const r = await second.call('get_selection');
  assert.equal(r.result.isError, false);
  assert.equal(fake.state.pairCount, 1);
  await finish(assert, second, [fake]);
});

test('tools/list is Spredin’s own list (and connect_spredin) once paired, and list_changed says when it differs', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  await c.initialize();
  const before = await c.request('tools/list');
  assert.deepEqual(before.result.tools, PACKAGED);
  await c.call('get_selection'); // pairs
  await c.waitFor((m) => m.method === 'notifications/tools/list_changed', 5_000, 'list_changed after pairing');
  const after = await c.request('tools/list');
  assert.deepEqual(after.result.tools, LIVE);
  assert.equal(fake.state.pairCount, 1, 'tools/list never pairs');
  await sleep(200);
  assert.equal(c.notifications('notifications/tools/list_changed').length, 1, 'said once');
  await finish(assert, c, [fake]);
});

test('with no workbook window Spredin lists only its two tools: the packaged list is offered instead', async () => {
  const fake = await startFakeSpredin({ tools: FAKE_TOOLS.filter((t) => ['list_workbooks', 'use_workbook'].includes(t.name)) });
  const c = startConnector({ ports: fake.range });
  seed(fake, c);
  await c.initialize();
  const r = await c.request('tools/list');
  assert.deepEqual(r.result.tools, PACKAGED, 'Claude still learns the workbook tools');
  assert.ok(fake.mcp().length >= 2, 'Spredin was asked');
  fake.state.tools = FAKE_TOOLS; // a workbook is opened
  const r2 = await c.request('tools/list');
  assert.deepEqual(r2.result.tools, LIVE);
  await finish(assert, c, [fake]);
});

test('a slow Allow: the call shows Spredin’s code and says to allow only if they match; the next call uses the token', async () => {
  const fake = await startFakeSpredin({ pairDelayMs: 1_500 });
  const c = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_PAIR_WAIT_MS: '300' } });
  await c.initialize();
  await c.request('tools/list');
  const t0 = Date.now();
  const r = await c.call('read_range', { range: 'A1' });
  const waited = Date.now() - t0;
  assert.equal(r.result.isError, true);
  const [code] = fake.state.codes;
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.match(textOf(r), new RegExp(`Show the user this code: ${formatCode(code)}\\.`));
  assert.match(textOf(r), /click Allow in Spredin Pro only if Spredin Pro shows the same code, then call this tool again/);
  assert.ok(waited < 1_400, `the call came back in ${waited} ms, before the person answered`);
  assert.equal(fs.existsSync(c.pairingFile), false);

  await until(() => fs.existsSync(c.pairingFile), 5_000, 'the token to be saved in the background');
  if (POSIX) assert.equal(fs.statSync(c.pairingFile).mode & 0o777, 0o600);
  await c.waitFor((m) => m.method === 'notifications/tools/list_changed', 5_000, 'list_changed once paired');
  const r2 = await c.call('read_range', { range: 'A1' });
  assert.equal(r2.result.isError, false);
  assert.equal(fake.state.pairCount, 1, 'the second call did not ask again');
  await finish(assert, c, [fake]);
});

test('a 401 keeps the pairing and asks nothing: Claude is told to call connect_spredin if the user wants', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  writePairing(c, { token: crypto.randomBytes(32).toString('hex'), id: 'gone' }); // Spredin does not know it
  const before = fileBytes(c);
  await c.initialize();
  for (let i = 0; i < 2; i++) {
    const r = await c.call('read_range', { range: 'A1' });
    assert.equal(r.result.isError, true);
    assert.equal(textOf(r), MESSAGES.refused);
  }
  const list = await c.request('tools/list');
  assert.deepEqual(list.result.tools, PACKAGED);
  assert.ok(fileBytes(c).equals(before), 'the pairing file is kept as it was');
  assert.equal(fake.state.pairCount, 0, 'no pairing was started');
  assert.equal(fake.calls().length, 0, 'no call went out on a refused pairing');
  await finish(assert, c, [fake]);
});

test('Disconnect in Spredin sticks; connect_spredin pairs again and replaces the file', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  const old = seed(fake, c);
  await c.initialize();
  assert.equal((await c.call('get_selection')).result.isError, false);
  fake.disconnectAll();
  const r = await c.call('get_selection');
  assert.equal(textOf(r), MESSAGES.refused);
  assert.equal(readPairing(c).token, old.token, 'kept');
  assert.equal(fake.state.pairCount, 0);

  const connect = await c.call('connect_spredin');
  assert.equal(connect.result.isError, false, textOf(connect));
  assert.equal(textOf(connect), MESSAGES.connected);
  assert.equal(fake.state.pairCount, 1);
  const now = readPairing(c);
  assert.notEqual(now.token, old.token, 'replaced on success');
  assert.ok(fake.state.pairings.has(now.id));
  const r2 = await c.call('get_selection');
  assert.equal(r2.result.isError, false, textOf(r2));
  await finish(assert, c, [fake]);
});

test('connect_spredin that is declined, or still waiting, keeps the old pairing file', async () => {
  const fake = await startFakeSpredin({ pair: 'decline' });
  const c = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_PAIR_WAIT_MS: '300' } });
  seed(fake, c);
  const before = fileBytes(c);
  await c.initialize();
  const declined = await c.call('connect_spredin');
  assert.equal(textOf(declined), MESSAGES.declined);
  assert.ok(fileBytes(c).equals(before));
  fake.state.pair = 'allow';
  fake.state.pairDelayMs = 1_000;
  const pending = await c.call('connect_spredin');
  assert.equal(pending.result.isError, true);
  assert.match(textOf(pending), new RegExp(`Show the user this code: ${formatCode(fake.state.codes.at(-1))}\\.`));
  assert.ok(fileBytes(c).equals(before), 'not replaced while Spredin is asking');
  await until(() => !fileBytes(c).equals(before), 5_000, 'the new pairing to replace the old');
  await finish(assert, c, [fake]);
});

for (const sign of ['none', 'bad']) {
  test(`an answer that is ${sign === 'none' ? 'not signed' : 'wrongly signed'} is never used, and that port is sent nothing more`, async () => {
    const fake = await startFakeSpredin({ sign });
    const c = startConnector({ ports: fake.range });
    seed(fake, c);
    await c.initialize();
    const r = await c.call('describe_sheet', { sheet: 'Sales' });
    assert.equal(textOf(r), MESSAGES.refused);
    assert.ok(!c.lines.some((l) => l.includes('called describe_sheet')), 'nothing from the unsigned answer reaches Claude');
    assert.equal(fake.calls().length, 0, 'the call was never sent to it');
    const seen = fake.state.requests.length;
    await c.call('describe_sheet', { sheet: 'Sales' });
    await c.request('tools/list');
    assert.equal(fake.state.requests.length, seen, 'not even GET /spredin again this session');
    assert.match(c.stderr, /did not sign; nothing more is sent there this session/);
    await finish(assert, c, [fake]);
  });
}

for (const kind of ['unsigned', 'badsig', 'refuse']) {
  test(`an impostor (${kind}) on the lowest port: the call goes to the real Spredin, and the impostor learns nothing`, async () => {
    const base = randomBase();
    const impostor = await startImpostor(base, kind);
    const fake = await startFakeSpredin({ base, offset: 3 });
    const c = startConnector({ ports: portRange(base) });
    seed(fake, c);
    await c.initialize();
    const r = await c.call('describe_sheet', { sheet: 'Sales' });
    assert.equal(textOf(r), 'called describe_sheet {"sheet":"Sales"}');
    assert.ok(!c.lines.some((l) => l.includes('IMPOSTOR')));
    const sent = impostor.requests.length;
    assert.ok(sent >= 2, 'it was asked GET /spredin and a signed ping');
    const posts = impostor.requests.filter((q) => q.url !== '/spredin');
    assert.ok(posts.length >= 1 && posts.every((q) => q.url === '/mcp' && q.json?.method === 'ping'), 'only ever a signed ping');
    await c.call('describe_sheet', { sheet: 'Sales' });
    if (kind !== 'refuse') assert.equal(impostor.requests.length, sent, 'an unsigned answer: nothing more is sent there');
    await finish(assert, c, [fake], [impostor]);
  });
}

test('an impostor that passes requests on to Spredin gains nothing: the port inside the MAC makes Spredin refuse them', async () => {
  const base = randomBase();
  const fake = await startFakeSpredin({ base, offset: 4 });
  const relay = await startImpostor(base, 'relay', fake.port);
  const c = startConnector({ ports: portRange(base) });
  seed(fake, c);
  await c.initialize();
  const r = await c.call('describe_sheet', { sheet: 'Sales' });
  assert.equal(textOf(r), 'called describe_sheet {"sheet":"Sales"}');
  const relayed = relay.requests.filter((q) => q.url === '/mcp');
  assert.ok(relayed.length >= 1);
  assert.ok(relayed.every((q) => q.relayedStatus === 401), 'Spredin refused every relayed request');
  assert.equal(fake.calls().length, 1);
  assert.equal(fake.calls()[0].headers.host, `127.0.0.1:${fake.port}`, 'the call came straight to Spredin');
  await finish(assert, c, [fake], [relay]);
});

test('pairing skips a port whose program does not run as this user (lsof), and pairs with Spredin behind it', async () => {
  const base = randomBase();
  const impostor = await startImpostor(base, 'unsigned');
  const fake = await startFakeSpredin({ base, offset: 2 });
  // lsof lists a process only for the real Spredin's port.
  const lsof = fakeLsof(`case "$3" in *:${fake.port}) echo p4242 ;; *) exit 1 ;; esac`);
  const c = startConnector({ ports: portRange(base), env: { SPREDIN_CONNECTOR_LSOF: lsof.file } });
  await c.initialize();
  const r = await c.call('get_selection');
  assert.equal(r.result.isError, false, textOf(r));
  assert.equal(fake.state.pairCount, 1);
  assert.equal(impostor.requests.filter((q) => q.url === '/pair').length, 0, 'the impostor was never asked to pair');
  await finish(assert, c, [fake], [impostor]);
});

test('lsof finds no process of this user on the port: no pairing, and Claude says why', async () => {
  const fake = await startFakeSpredin();
  const lsof = fakeLsof('exit 1');
  const c = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_LSOF: lsof.file } });
  await c.initialize();
  const r = await c.call('get_selection');
  if (process.platform === 'darwin') {
    assert.equal(textOf(r), MESSAGES['other-user']);
    assert.equal(fake.count('POST', '/pair'), 0, 'nothing was sent to pair');
    assert.deepEqual(lsof.args(), ['-a', '-nP', `-iTCP@127.0.0.1:${fake.port}`, '-sTCP:LISTEN', '-Fp'], 'lsof, exactly these arguments');
  } else {
    assert.equal(r.result.isError, false, 'no lsof check off macOS');
  }
  await finish(assert, c, [fake]);
});

test('lsof missing or failing: no pairing, and the reason is given', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_LSOF: '/nonexistent/lsof' } });
  await c.initialize();
  const r = await c.call('get_selection');
  assert.match(textOf(r), /could not check which program is answering/);
  assert.match(textOf(r), /\/nonexistent\/lsof is missing/);
  const broken = fakeLsof('echo "lsof: bad option" >&2; exit 2');
  const c2 = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_LSOF: broken.file } });
  await c2.initialize();
  assert.match(textOf(await c2.call('get_selection')), /lsof failed with code 2/);
  assert.equal(fake.count('POST', '/pair'), 0);
  await finish(assert, c, [fake]);
  await finish(assert, c2, [fake]);
});

test('declined, timeout, busy, wait, no-window, bad-request and stopped each give a clear error and save nothing', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  await c.initialize();
  const cases = { decline: 'declined', timeout: 'timeout', busy: 'busy', wait: 'wait', 'no-window': 'no-window', 'bad-request': 'bad-request', stopped: 'unreachable' };
  for (const [mode, kind] of Object.entries(cases)) {
    fake.state.pair = mode;
    const r = await c.call('write_cells', { start: 'A1', values: [['1']] });
    assert.equal(r.result.isError, true, mode);
    assert.equal(textOf(r), MESSAGES[kind], mode);
  }
  fake.state.pair = 'bad-token';
  const bad = await c.call('write_cells', { start: 'A1', values: [['1']] });
  assert.match(textOf(bad), /could not pair/);
  assert.equal(fs.existsSync(c.pairingFile), false);
  assert.equal(fake.calls().length, 0, 'nothing reached /mcp without a pairing');
  await finish(assert, c, [fake]);
});

test('a decline that comes after the call stopped waiting is told to the next call; with no pairing file, the one after asks again', async () => {
  const fake = await startFakeSpredin({ pair: 'decline', pairDelayMs: 600 });
  const c = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_PAIR_WAIT_MS: '200' } });
  await c.initialize();
  const r1 = await c.call('get_selection');
  assert.match(textOf(r1), /Show the user this code/);
  await sleep(900);
  const r2 = await c.call('get_selection');
  assert.equal(textOf(r2), MESSAGES.declined);
  assert.equal(fake.state.pairCount, 1, 'the decline was reported, not asked again');
  fake.state.pair = 'allow';
  fake.state.pairDelayMs = 0;
  const r3 = await c.call('get_selection');
  assert.equal(r3.result.isError, false);
  assert.equal(fake.state.pairCount, 2);
  assert.notEqual(fake.state.codes[0], fake.state.codes[1], 'a fresh code for each request');
  await finish(assert, c, [fake]);
});

test('calls at the same time share one pairing and are answered by id', async () => {
  const fake = await startFakeSpredin({
    onCall: async (name, args) => {
      await sleep(args.ms);
      return { content: [{ type: 'text', text: `done ${args.tag}` }], isError: false };
    },
  });
  const c = startConnector({ ports: fake.range });
  await c.initialize();
  const slow = c.call('read_range', { tag: 'a', ms: 400 }, { id: 'a' });
  const fast = c.call('read_range', { tag: 'b', ms: 10 }, { id: 'b' });
  const mid = c.call('read_range', { tag: 'c', ms: 200 }, { id: 'c' });
  const [ra, rb, rc] = await Promise.all([slow, fast, mid]);
  assert.equal(textOf(ra), 'done a');
  assert.equal(textOf(rb), 'done b');
  assert.equal(textOf(rc), 'done c');
  const order = c.messages.filter((m) => ['a', 'b', 'c'].includes(m.id)).map((m) => m.id);
  assert.deepEqual(order, ['b', 'c', 'a'], 'answered as they finished, each under its own id');
  assert.equal(fake.state.pairCount, 1);
  await finish(assert, c, [fake]);
});

test('Spredin is found behind something else, and again after it moves', async () => {
  const base = randomBase();
  const other = await startImpostor(base, 'other');
  const fake = await startFakeSpredin({ base, offset: 3 });
  const c = startConnector({ ports: portRange(base) });
  seed(fake, c);
  await c.initialize();
  assert.equal((await c.call('get_selection')).result.isError, false);

  // Spredin quits and comes back on another port; it still knows the pairing.
  await fake.close();
  const moved = await startFakeSpredin({ base, offset: 5 });
  moved.state.pairings = fake.state.pairings;
  moved.state.tokens = fake.state.tokens;
  const r2 = await c.call('get_selection');
  assert.equal(r2.result.isError, false, textOf(r2));
  assert.equal(moved.calls().length, 1);
  assert.equal(moved.state.pairCount, 0);
  await finish(assert, c, [fake, moved], [other]);
});

test('a Spredin with a newer connector protocol says to update the extension', async () => {
  const fake = await startFakeSpredin({ connector: 2 });
  const c = startConnector({ ports: fake.range });
  await c.initialize();
  assert.equal(textOf(await c.call('get_selection')), MESSAGES.incompatible);
  assert.equal(fake.state.pairCount, 0);
  await finish(assert, c, [fake]);
});

test('a JSON-RPC error from Spredin is passed on as one', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  seed(fake, c);
  await c.initialize();
  const r = await c.call('no_such_tool');
  assert.deepEqual(r.error, { code: -32602, message: 'Unknown tool: no_such_tool' });
  await finish(assert, c, [fake]);
});

test('cancelling a call: a signed notifications/cancelled to Spredin, the request hung up, no answer', async () => {
  const fake = await startFakeSpredin({ onCall: () => new Promise(() => {}) });
  const c = startConnector({ ports: fake.range });
  seed(fake, c);
  await c.initialize();
  c.send({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'write_cells', arguments: { start: 'A1', values: [['1']] } } });
  await until(() => fake.calls().length === 1, 5_000, 'the call to reach Spredin');
  c.notify('notifications/cancelled', { requestId: 77, reason: 'user stopped' });
  await until(() => fake.calls()[0].aborted, 3_000, 'the request to Spredin to be hung up');
  await until(() => fake.cancellations().length === 1, 3_000, 'the cancellation to reach Spredin');
  const [cancel] = fake.cancellations();
  assert.equal(cancel.json.params.requestId, fake.calls()[0].json.id, 'by the id it was forwarded under');
  assert.equal(cancel.json.id, undefined, 'a notification');
  assert.equal(cancel.macOk, true, 'signed like any request');
  assert.deepEqual((await c.request('ping')).result, {});
  await sleep(200);
  assert.equal(c.messages.filter((m) => m.id === 77).length, 0);
  await finish(assert, c, [fake]);
});

test('progress notifications while Spredin works, only when the client asked for them', async () => {
  const fake = await startFakeSpredin({
    onCall: async () => {
      await sleep(550);
      return { content: [{ type: 'text', text: 'approved' }], isError: false };
    },
  });
  const c = startConnector({ ports: fake.range, env: { SPREDIN_CONNECTOR_PROGRESS_MS: '100' } });
  seed(fake, c);
  await c.initialize();
  const r = await c.request('tools/call', { name: 'write_cells', arguments: { start: 'A1', values: [['1']] }, _meta: { progressToken: 'p-1' } });
  assert.equal(textOf(r), 'approved');
  const progress = c.notifications('notifications/progress');
  assert.ok(progress.length >= 3, `got ${progress.length} progress notifications`);
  assert.ok(progress.every((n) => n.params.progressToken === 'p-1'));
  const steps = progress.map((n) => n.params.progress);
  assert.equal(new Set(steps).size, steps.length);
  assert.deepEqual(steps, [...steps].sort((x, y) => x - y), 'progress only goes up');
  const n = progress.length;
  await c.call('write_cells', { start: 'A1', values: [['2']] });
  await sleep(150);
  assert.equal(c.notifications('notifications/progress').length, n, 'no token, no progress');
  await finish(assert, c, [fake]);
});

test('without SPREDIN_CONNECTOR_TEST=1 the test hooks are ignored: the pairing file there is not even read', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range, test: false });
  // A pairing at the hook's path; the real path (under the temp HOME) has none.
  seed(fake, c);
  await c.initialize();
  const r = await c.request('tools/list');
  assert.deepEqual(r.result.tools, PACKAGED);
  assert.deepEqual(c.net().filter((x) => x.connect), [], 'no pairing found at the real path: no connection at all');
  assert.equal(fake.state.requests.length, 0);
  assert.doesNotMatch(c.stderr, /test mode/);
  await finish(assert, c, [fake]);
});
