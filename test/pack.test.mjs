// tools/pack.py: the .mcpb is built from the committed tree, holds exactly
// the extension's files, gives the same bytes every time, refuses a dirty
// tree, and the server inside it runs on its own.
//
// Each test packs a snapshot: the working tree's files (tracked and new, not
// ignored) committed to a fresh repository in a temp folder, so the tests
// check the pack.py being worked on without touching this repository.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, tempDir, killAll } from './support/harness.mjs';
import { annotated } from '../server/connector.js';

afterEach(killAll);

const PY = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const GIT = spawnSync('git', ['--version']).status === 0 ? 'git' : null;
const SKIP = (!PY && 'no python3') || (!GIT && 'no git');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
const NAME = `spredin-connector-${manifest.version}.mcpb`;
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** The working tree, committed in a fresh repository elsewhere. */
function snapshot() {
  const dir = tempDir('spredin-pack-');
  const list = git(REPO, 'ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean);
  for (const rel of list) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) continue; // deleted but not yet committed
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dir, rel));
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'snapshot');
  return dir;
}

function pack(repo, out, ...extra) {
  return spawnSync(PY, ['-I', path.join(repo, 'tools', 'pack.py'), '--out', out, ...extra], { encoding: 'utf8' });
}

function zipRead(file, ...names) {
  const r = spawnSync(
    PY,
    ['-I', '-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"entries": [[i.filename, i.external_attr >> 16, i.create_system] for i in z.infolist()], "files": {n: z.read(n).decode() for n in sys.argv[2:]}}))', file, ...names],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the .mcpb holds exactly the extension’s files, manifest.json at the root, and pack prints its SHA-256', { skip: SKIP }, () => {
  const repo = snapshot();
  const out = tempDir();
  const r = pack(repo, out);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(out, NAME);
  const { entries } = zipRead(file);
  assert.deepEqual(entries.map((e) => e[0]), [
    'manifest.json',
    'package.json',
    'icon.png',
    'LICENSE',
    'README.md',
    'server/connector.js',
    'server/index.js',
    'server/tools.json',
  ]);
  for (const [name, mode, system] of entries) {
    assert.equal(system, 3, name);
    assert.equal(mode & 0o777, 0o644, name);
  }
  const sha = (/sha256\s+([0-9a-f]{64})/.exec(r.stdout) ?? [])[1];
  const actual = spawnSync(PY, ['-I', '-c', 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())', file], { encoding: 'utf8' }).stdout.trim();
  assert.equal(sha, actual, 'the printed SHA-256 is the file’s');
  assert.match(r.stdout, new RegExp(`commit\\s+${git(repo, 'rev-parse', 'HEAD').trim()}`));
});

test('packing twice gives the same bytes', { skip: SKIP }, () => {
  const repo = snapshot();
  const a = tempDir();
  const b = tempDir();
  assert.equal(pack(repo, a).status, 0);
  assert.equal(pack(repo, b).status, 0);
  assert.ok(fs.readFileSync(path.join(a, NAME)).equals(fs.readFileSync(path.join(b, NAME))));
});

test('a dirty tree is refused; --allow-dirty packs HEAD without the changes', { skip: SKIP }, () => {
  const repo = snapshot();
  const committed = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  fs.appendFileSync(path.join(repo, 'README.md'), '\nnot committed\n');
  const out = tempDir();
  const refused = pack(repo, out);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /uncommitted or untracked changes/);
  assert.equal(fs.existsSync(path.join(out, NAME)), false, 'nothing was written');

  fs.writeFileSync(path.join(repo, 'server', 'extra.js'), '// new and untracked\n');
  git(repo, 'checkout', '--', 'README.md');
  assert.notEqual(pack(repo, out).status, 0, 'an untracked file counts too');

  fs.appendFileSync(path.join(repo, 'README.md'), '\nnot committed\n');
  const allowed = pack(repo, out, '--allow-dirty');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /packing HEAD without them/);
  const { entries, files } = zipRead(path.join(out, NAME), 'README.md');
  assert.equal(files['README.md'], committed, 'HEAD’s README, not the working copy');
  assert.ok(!entries.some((e) => e[0] === 'server/extra.js'), 'an untracked file is not packed');
});

test('the server inside the .mcpb runs on its own and offers the packaged tools', { skip: SKIP, timeout: 30_000 }, async () => {
  const repo = snapshot();
  const out = tempDir();
  assert.equal(pack(repo, out).status, 0);
  const where = tempDir();
  const x = spawnSync(PY, ['-I', '-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', path.join(out, NAME), where], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  // As Claude Desktop would: node ${__dirname}/server/index.js, from somewhere else.
  const child = spawn(process.execPath, [path.join(where, 'server', 'index.js')], {
    cwd: tempDir(),
    env: { PATH: process.env.PATH, HOME: where },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out2 = '';
  child.stdout.on('data', (c) => (out2 += c));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  const msgs = out2.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.version, manifest.version);
  const packaged = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'tools.json'), 'utf8')).tools.map(annotated);
  assert.deepEqual(msgs.find((m) => m.id === 2).result.tools, packaged);
});
