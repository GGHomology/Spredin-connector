// manifest.json against the MCPB 0.3 schema (schemas/mcpb-manifest-v0.3.schema.json
// in github.com/modelcontextprotocol/mcpb; its top level, server, tools and
// compatibility objects all have additionalProperties: false), and the
// packaged tool list against Spredin Pro's own (when a checkout is beside us).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './support/harness.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const tools = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'tools.json'), 'utf8')).tools;

const TOP = [
  '$schema', 'dxt_version', 'manifest_version', 'name', 'display_name', 'version', 'description', 'long_description',
  'author', 'repository', 'homepage', 'documentation', 'support', 'icon', 'icons', 'screenshots', 'localization',
  'server', 'tools', 'tools_generated', 'prompts', 'prompts_generated', 'keywords', 'license', 'privacy_policies',
  'compatibility', 'user_config', '_meta',
];
const subset = (obj, allowed, where) => {
  for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `${where}: "${k}" is not in the 0.3 schema`);
};
const isUrl = (u) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

test('manifest.json has only what MCPB 0.3 allows, and what it requires', () => {
  assert.equal(manifest.manifest_version, '0.3');
  subset(manifest, TOP, 'manifest');
  for (const k of ['name', 'version', 'description', 'author', 'server']) assert.ok(manifest[k] !== undefined, k);
  assert.equal(manifest.name, 'spredin-connector');
  assert.equal(manifest.display_name, 'Spredin Pro');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  subset(manifest.author, ['name', 'email', 'url'], 'author');
  assert.equal(manifest.author.name, 'GGHomology');
  subset(manifest.repository, ['type', 'url'], 'repository');
  assert.equal(manifest.repository.url, 'https://github.com/GGHomology/Spredin-connector');
  for (const k of ['homepage', 'documentation', 'support']) assert.ok(isUrl(manifest[k]), k);
  assert.equal(manifest.homepage, 'https://spredin.com');
  assert.deepEqual(manifest.privacy_policies, ['https://spredin.com/privacy']);
  assert.equal(manifest.user_config, undefined, 'nothing to configure');
});

test('manifest server: node, ${__dirname}/server/index.js, which exists', () => {
  const { server } = manifest;
  subset(server, ['type', 'entry_point', 'mcp_config'], 'server');
  assert.equal(server.type, 'node');
  assert.equal(server.entry_point, 'server/index.js');
  assert.ok(fs.existsSync(path.join(REPO, server.entry_point)));
  subset(server.mcp_config, ['command', 'args', 'env', 'platform_overrides'], 'mcp_config');
  assert.equal(server.mcp_config.command, 'node');
  assert.deepEqual(server.mcp_config.args, ['${__dirname}/server/index.js']);
  for (const v of Object.values(server.mcp_config.env ?? {})) assert.equal(typeof v, 'string');
});

test('manifest compatibility: macOS only until Spredin for Windows exists, node >= 18', () => {
  subset(manifest.compatibility, ['claude_desktop', 'platforms', 'runtimes'], 'compatibility');
  // SECURITY.md: the listener check before pairing is macOS's; Windows waits
  // for Spredin for Windows and its own check.
  assert.deepEqual(manifest.compatibility.platforms, ['darwin']);
  subset(manifest.compatibility.runtimes, ['python', 'node'], 'runtimes');
  assert.equal(manifest.compatibility.runtimes.node, '>=18.0.0');
  assert.equal(pkg.engines.node, '>=18');
});

test('manifest tools are the packaged tools, by name and order, each with one plain line', () => {
  assert.deepEqual(manifest.tools.map((t) => t.name), tools.map((t) => t.name));
  for (const t of manifest.tools) {
    subset(t, ['name', 'description'], `tool ${t.name}`);
    assert.ok(t.description && t.description.length <= 140 && !t.description.includes('\n'), t.name);
  }
  assert.equal(manifest.tools_generated, true, 'Spredin may offer tools the packaged list does not know yet');
});

test('tools.json: every tool complete, the connector’s two included, names unique', () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ['describe_sheet', 'read_range', 'aggregate', 'find', 'get_selection', 'write_cells', 'run_python', 'memory', 'slides', 'python_help', 'list_workbooks', 'use_workbook', 'connect_spredin']) {
    assert.ok(names.includes(n), n);
  }
  for (const t of tools) {
    assert.deepEqual(Object.keys(t), ['name', 'description', 'inputSchema'], t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
  assert.deepEqual(tools.find((t) => t.name === 'use_workbook').inputSchema.required, ['name']);
  assert.equal(names.at(-1), 'connect_spredin', 'the extension’s own tool comes last, as the connector appends it');
});

test('no text a user or Claude reads promises that every change is approved', () => {
  const texts = {
    'manifest description': manifest.description,
    'manifest long_description': manifest.long_description,
    ...Object.fromEntries(manifest.tools.map((t) => [`manifest tool ${t.name}`, t.description])),
    README: fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'),
    SECURITY: fs.readFileSync(path.join(REPO, 'SECURITY.md'), 'utf8'),
  };
  for (const [where, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /every change|each change (?:waits|needs)|approve each change|approval for every/i, where);
  }
  assert.match(manifest.description, /unless you turned on applying them without asking/);
  assert.match(manifest.long_description, /read every open workbook without asking/);
  for (const name of ['write_cells', 'run_python', 'slides']) {
    assert.match(manifest.tools.find((t) => t.name === name).description, /unless you let/, name);
  }
});

test('one version everywhere; the package is an ES module (the bundle needs that)', () => {
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.name, manifest.name);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined, 'no npm dependencies');
  assert.equal(pkg.license, 'MIT');
  assert.equal(manifest.license, 'MIT');
});

test('the icon is a PNG', () => {
  const head = fs.readFileSync(path.join(REPO, manifest.icon)).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

const SRC = process.env.SPREDIN_SRC ?? path.resolve(REPO, '..', 'spredin-pro');
const VITE_NODE = path.join(SRC, 'node_modules', '.bin', 'vite-node');
test(
  'tools.json and the manifest match Spredin Pro’s tools.ts (tools/gen-tools.mts --check)',
  { skip: !fs.existsSync(VITE_NODE) && `no Spredin Pro checkout at ${SRC}`, timeout: 120_000 },
  () => {
    const r = spawnSync(VITE_NODE, [path.join(REPO, 'tools', 'gen-tools.mts'), '--check'], { cwd: SRC, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  },
);
