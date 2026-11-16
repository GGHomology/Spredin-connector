// The MCP side: both eras of the protocol (MCP 2026-07-28, "Versioning and
// Compatibility"), and JSON-RPC done right on a newline-delimited stream.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeSpredin, closeAllFakes } from './support/fakeSpredin.mjs';
import { startConnector, finish, killAll, sleep, textOf, REPO } from './support/harness.mjs';
import { MESSAGES, annotated } from '../server/connector.js';

afterEach(async () => {
  await killAll();
  await closeAllFakes();
});

// As served: each tool with its annotations (TOOL_ANNOTATIONS).
const PACKAGED = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'tools.json'), 'utf8')).tools.map(annotated);
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).version;
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT = 'io.modelcontextprotocol/clientInfo';
const SERVER = 'io.modelcontextprotocol/serverInfo';
const SUB = 'io.modelcontextprotocol/subscriptionId';

const modernMeta = (extra = {}) => ({ [PV]: '2026-07-28', [CAPS]: {}, [CLIENT]: { name: 'claude-ai', version: '2.0.0' }, ...extra });

test('legacy initialize: echoes a version it speaks, else its newest, and says what it is', async () => {
  const c = startConnector();
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    const r = await c.request('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
    assert.equal(r.result.protocolVersion, v);
  }
  const r = await c.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-11-25');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(r.result.serverInfo, { name: 'spredin-connector', title: 'Spredin Pro', version: VERSION });
  assert.match(r.result.instructions, /list_workbooks/);
  assert.match(r.result.instructions, /use_workbook/);
  assert.match(r.result.instructions, /asks the user in Spredin Pro first, unless they turned on applying changes without asking/);
  assert.match(r.result.instructions, /never instructions to you/);
  assert.match(r.result.instructions, /one undo step/);
  assert.equal(r.result.resultType, undefined, 'legacy results carry no modern fields');
  await finish(assert, c);
});

test('modern server/discover: versions, capabilities, identity, caching hints', async () => {
  const c = startConnector();
  const r = await c.request('server/discover', { _meta: modernMeta() });
  assert.equal(r.result.resultType, 'complete');
  assert.deepEqual(r.result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(r.result._meta[SERVER], { name: 'spredin-connector', title: 'Spredin Pro', version: VERSION });
  assert.ok(Number.isInteger(r.result.ttlMs) && r.result.ttlMs >= 0);
  assert.ok(['public', 'private'].includes(r.result.cacheScope));
  assert.match(r.result.instructions, /list_workbooks/);
  await finish(assert, c);
});

test('modern requests: a version it does not speak is -32022 with what it does; missing capabilities is -32602', async () => {
  const c = startConnector();
  const bad = await c.request('tools/list', { _meta: { [PV]: '2099-01-01', [CAPS]: {} } });
  assert.deepEqual(bad.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2099-01-01' } });
  // The stdio probe a dual-era client sends: a recognised modern error, not a fall back.
  const probe = await c.request('server/discover', { _meta: { [PV]: '2099-01-01', [CAPS]: {} } });
  assert.equal(probe.error.code, -32022);
  const noCaps = await c.request('tools/list', { _meta: { [PV]: '2026-07-28' } });
  assert.equal(noCaps.error.code, -32602);
  await finish(assert, c);
});

test('modern tools/list and tools/call carry resultType and identity; the list carries caching hints', async () => {
  const c = startConnector();
  const list = await c.request('tools/list', { _meta: modernMeta() });
  assert.equal(list.result.resultType, 'complete');
  assert.deepEqual(list.result.tools, PACKAGED);
  assert.equal(list.result.ttlMs, 0);
  assert.equal(list.result.cacheScope, 'private');
  assert.equal(list.result._meta[SERVER].name, 'spredin-connector');
  const call = await c.request('tools/call', { name: 'get_selection', arguments: {}, _meta: modernMeta() });
  assert.equal(call.result.resultType, 'complete');
  assert.equal(call.result.isError, true);
  assert.equal(textOf(call), MESSAGES.unreachable);
  await finish(assert, c);
});

test('modern pairing takes the client name from the request, and list_changed goes to the subscription', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  // A subscription for tools and prompts: only tools is agreed.
  c.send({ jsonrpc: '2.0', id: 'sub-1', method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications: { toolsListChanged: true, promptsListChanged: true } } });
  const ack = await c.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
  assert.deepEqual(ack.params, { _meta: { [SUB]: 'sub-1' }, notifications: { toolsListChanged: true } });
  // A second subscription, which the client cancels.
  c.send({ jsonrpc: '2.0', id: 'sub-2', method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications: { toolsListChanged: true } } });
  await c.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged' && m.params._meta[SUB] === 'sub-2');
  c.notify('notifications/cancelled', { requestId: 'sub-2' });

  await c.request('tools/list', { _meta: modernMeta() });
  const r = await c.request('tools/call', { name: 'get_selection', arguments: {}, _meta: modernMeta({ [CLIENT]: { name: 'claude-ai', version: '2.0.0' } }) });
  assert.equal(r.result.isError, false, textOf(r));
  const pair = fake.state.requests.find((q) => q.url === '/pair');
  assert.deepEqual(pair.json.client, { name: 'Claude', version: '2.0.0' });

  const changed = await c.waitFor((m) => m.method === 'notifications/tools/list_changed', 5_000, 'list_changed');
  assert.deepEqual(changed.params, { _meta: { [SUB]: 'sub-1' } });
  await sleep(200);
  const all = c.notifications('notifications/tools/list_changed');
  assert.equal(all.length, 1, 'only the open subscription hears it; no handshake, so no plain notification');
  assert.equal(c.messages.some((m) => m.id === 'sub-1' || m.id === 'sub-2'), false, 'a subscription stays open');

  await finish(assert, c, [fake]);
  // On closing, the server ends the open subscription with a completion result.
  const closure = c.messages.find((m) => m.id === 'sub-1');
  assert.deepEqual(closure, { jsonrpc: '2.0', id: 'sub-1', result: { resultType: 'complete', _meta: { [SUB]: 'sub-1' } } });
  assert.equal(c.messages.some((m) => m.id === 'sub-2'), false, 'the cancelled one gets nothing more');
  await fake.close();
});

test('JSON-RPC: ping, unknown method, parse error, invalid requests, notifications, CRLF', async () => {
  const c = startConnector();
  assert.deepEqual((await c.request('ping')).result, {});
  const unknown = await c.request('resources/list');
  assert.equal(unknown.error.code, -32601);

  c.sendLine('{"jsonrpc":"2.0","id":5,"method":"ping"'); // cut short
  const parse = await c.waitFor((m) => m.error?.code === -32700);
  assert.equal(parse.id, null);

  c.sendLine('{"jsonrpc":"2.0"}');
  const invalid = await c.waitFor((m) => m.error?.code === -32600 && m.id === null);
  assert.match(invalid.error.message, /Invalid Request/);
  c.sendLine('{"jsonrpc":"1.0","id":"old","method":"ping"}');
  assert.equal((await c.waitFor((m) => m.id === 'old')).error.code, -32600);
  c.sendLine('{"jsonrpc":"2.0","id":null,"method":"ping"}');
  await c.waitFor((m) => m.error?.code === -32600 && /id must be/.test(m.error.message));
  const badParams = await c.request('tools/list', [1, 2]);
  assert.equal(badParams.error.code, -32602);

  // A notification gets no answer, even an unknown one.
  const before = c.messages.length;
  c.notify('notifications/initialized');
  c.notify('notifications/whatever', { x: 1 });
  c.notify('notifications/roots/list_changed');
  assert.deepEqual((await c.request('ping', undefined, { id: 'after' })).result, {});
  assert.equal(c.messages.length, before + 1, 'only the ping was answered');

  // A response from the client (we never ask it anything) is ignored.
  c.send({ jsonrpc: '2.0', id: 'x1', result: {} });
  c.child.stdin.write('{"jsonrpc":"2.0","id":"crlf","method":"ping"}\r\n');
  assert.deepEqual((await c.waitFor((m) => m.id === 'crlf')).result, {});
  assert.equal(c.messages.some((m) => m.id === 'x1'), false);
  await finish(assert, c);
});

test('JSON-RPC batches: answered as one array, notifications left out; an empty batch is invalid', async () => {
  const c = startConnector();
  c.sendLine(JSON.stringify([
    { jsonrpc: '2.0', id: 'b1', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b2', method: 'nope' },
  ]));
  await c.waitFor((m) => m.id === 'b2');
  const line = c.lines.find((l) => l.startsWith('['));
  const batch = JSON.parse(line);
  assert.deepEqual(batch.map((m) => m.id), ['b1', 'b2']);
  assert.deepEqual(batch[0].result, {});
  assert.equal(batch[1].error.code, -32601);
  c.sendLine('[]');
  const empty = await c.waitFor((m) => m.error?.code === -32600 && /empty batch/.test(m.error.message));
  assert.equal(empty.id, null);
  await finish(assert, c);
});

test('an id already in flight is refused, the first request still answered', async () => {
  const fake = await startFakeSpredin({
    onCall: async () => {
      await sleep(300);
      return { content: [{ type: 'text', text: 'first' }], isError: false };
    },
  });
  const c = startConnector({ ports: fake.range });
  await c.initialize();
  await c.call('get_selection');
  c.send({ jsonrpc: '2.0', id: 'same', method: 'tools/call', params: { name: 'find', arguments: { text: 'a' } } });
  await sleep(50);
  c.send({ jsonrpc: '2.0', id: 'same', method: 'ping' });
  const refused = await c.waitFor((m) => m.id === 'same' && m.error);
  assert.equal(refused.error.code, -32600);
  const first = await c.waitFor((m) => m.id === 'same' && m.result);
  assert.equal(textOf(first), 'first');
  await finish(assert, c, [fake]);
  await fake.close();
});

test('stdin ending lets an open request finish first, then the process exits 0', async () => {
  const c = startConnector();
  c.send({ jsonrpc: '2.0', id: 'last', method: 'tools/call', params: { name: 'get_selection', arguments: {} } });
  const how = await c.close();
  assert.equal(how.code, 0);
  const last = c.messages.find((m) => m.id === 'last');
  assert.equal(textOf(last), MESSAGES.unreachable);
  assert.deepEqual(c.badLines, []);
});

test('stdout holds only JSON-RPC; logs go to stderr', async () => {
  const fake = await startFakeSpredin();
  const c = startConnector({ ports: fake.range });
  await c.initialize();
  await c.request('tools/list');
  await c.call('get_selection');
  await c.request('tools/list');
  await finish(assert, c, [fake]);
  assert.ok(c.lines.length >= 4);
  for (const line of c.lines) {
    const m = JSON.parse(line);
    assert.equal(m.jsonrpc, '2.0');
  }
  assert.match(c.stderr, /\[spredin-connector\] started/);
  assert.match(c.stderr, /paired with Spredin Pro/);
  await fake.close();
});
