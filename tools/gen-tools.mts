// Regenerate the packaged tool list from a Spredin Pro source checkout, so the
// extension offers Claude the same tools Spredin does, even before it can
// reach Spredin. Run it after every Spredin Pro release:
//
//   cd <spredin-pro checkout>
//   node_modules/.bin/vite-node <this repo>/tools/gen-tools.mts
//
// It imports `toolManifest()` from that checkout's src/agent/tools.ts by
// absolute path (SPREDIN_SRC, or the current folder) — the list Spredin's
// window gives the connector — adds the connector's own two tools
// (list_workbooks, use_workbook) exactly as src-tauri/src/connector.rs
// defines them, so the packaged list is what Spredin itself answers, then the
// tools this extension answers itself (connect_spredin, from
// server/connector.js), and writes:
//   server/tools.json    the full list: name, description, inputSchema
//   manifest.json        its `tools` field: names and one-line summaries
//
// `--check` writes nothing and exits 1 when either file would change.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SRC = process.env.SPREDIN_SRC ?? process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECK = process.argv.includes('--check');

const toolsTs = join(SRC, 'src', 'agent', 'tools.ts');
const tauriConf = join(SRC, 'src-tauri', 'tauri.conf.json');
const connectorRs = join(SRC, 'src-tauri', 'src', 'connector.rs');
if (!existsSync(toolsTs) || !existsSync(tauriConf) || !existsSync(connectorRs)) {
  console.error(
    `No Spredin Pro checkout at ${SRC} (looked for src/agent/tools.ts, src-tauri/src/connector.rs and src-tauri/tauri.conf.json).\n` +
      `Run this from a Spredin Pro checkout:\n  cd <spredin-pro> && node_modules/.bin/vite-node ${join(HERE, 'gen-tools.mts')}`,
  );
  process.exit(2);
}

const version: string = JSON.parse(readFileSync(tauriConf, 'utf8')).version;
const { toolManifest } = (await import(toolsTs)) as { toolManifest: () => Tool[] };

/**
 * The connector's own tools (PROTOCOL.md, "Which workbook"), read from
 * `connector_tool_defs()` in connector.rs: Spredin's core answers them and
 * appends them to every tools/list. Its body is a `vec![json!({…}), …]`
 * written as JSON with trailing commas; anything else fails loudly here.
 */
function connectorTools(): Tool[] {
  const rs = readFileSync(connectorRs, 'utf8');
  const m = /pub fn connector_tool_defs\(\)\s*->\s*Vec<Value>\s*\{\s*vec!\[([\s\S]*?)\]\s*\}\s*\n/.exec(rs);
  if (!m) throw new Error(`connector_tool_defs() not found in ${connectorRs}: update tools/gen-tools.mts`);
  const json = '[' + m[1].replace(/json!\(/g, '').replace(/\}\)\s*,?/g, '},').replace(/,(\s*[}\]])/g, '$1').replace(/,\s*$/, '') + ']';
  let defs: Tool[];
  try {
    defs = JSON.parse(json);
  } catch (e) {
    throw new Error(`connector_tool_defs() in ${connectorRs} is not plain JSON any more (${(e as Error).message}): update tools/gen-tools.mts`);
  }
  const names = defs.map((d) => d.name).join(',');
  if (names !== 'list_workbooks,use_workbook') throw new Error(`connector_tool_defs() gives ${names}; expected list_workbooks,use_workbook`);
  return defs;
}
const CONNECTOR_TOOLS = connectorTools();
const { EXTENSION_TOOLS } = (await import(join(ROOT, 'server', 'connector.js'))) as { EXTENSION_TOOLS: Tool[] };

/**
 * One line each for Claude Desktop's extension page, written for the person
 * installing it. A new Spredin tool needs a line here: `--check` fails until
 * it has one (a plain run falls back to its first sentence and says so).
 */
const SUMMARY: Record<string, string> = {
  describe_sheet: "See a sheet's layout: its tables, headings and kinds of column.",
  read_range: 'Read the cells in a range.',
  aggregate: "Count, sum and average a table's columns, by group if you like.",
  find: 'Find the cells that show some text.',
  get_selection: 'See what you have selected in Spredin Pro.',
  write_cells: 'Write values or formulas into cells. Asks you in Spredin Pro first, unless you let changes apply without asking.',
  run_python: 'Run Python on the workbook. A script that writes asks you first, unless you let changes apply without asking.',
  memory: "Read or change the workbook's notes for the assistant. A change always asks you first.",
  slides: "Read, change, show or export the workbook's slide decks. A change asks you first, unless you let it apply without asking.",
  python_help: "The full reference for Spredin Pro's Python scripting.",
  list_workbooks: 'List the open workbooks, and which one Claude works in.',
  use_workbook: 'Choose which open workbook Claude works in.',
  connect_spredin: 'Connect Claude to Spredin Pro again, when you ask it to. Spredin Pro asks you to allow it and shows a code.',
};

function firstSentence(text: string): string {
  const re = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index + 1);
    if (/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(before)) continue;
    return before.length > 140 ? `${before.slice(0, 139)}…` : before;
  }
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

const tools: Tool[] = [...toolManifest(), ...CONNECTOR_TOOLS, ...EXTENSION_TOOLS];
const seen = new Set<string>();
for (const t of tools) {
  if (typeof t.name !== 'string' || !t.name) throw new Error('A tool has no name');
  if (seen.has(t.name)) throw new Error(`Tool ${t.name} is listed twice`);
  seen.add(t.name);
  if (typeof t.description !== 'string' || !t.description) throw new Error(`Tool ${t.name} has no description`);
  if (t.inputSchema === null || typeof t.inputSchema !== 'object' || t.inputSchema.type !== 'object') {
    throw new Error(`Tool ${t.name}: inputSchema must be a JSON Schema object of type "object"`);
  }
}

const missing = tools.filter((t) => !SUMMARY[t.name]).map((t) => t.name);
const toolsJson =
  JSON.stringify(
    {
      generatedFrom: `Spredin Pro ${version} (src/agent/tools.ts) by tools/gen-tools.mts. Do not edit by hand.`,
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    },
    null,
    2,
  ) + '\n';

const manifestPath = join(ROOT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.tools = tools.map((t) => ({ name: t.name, description: SUMMARY[t.name] ?? firstSentence(t.description) }));
const manifestJson = JSON.stringify(manifest, null, 2) + '\n';

const outputs: [string, string][] = [
  [join(ROOT, 'server', 'tools.json'), toolsJson],
  [manifestPath, manifestJson],
];

if (CHECK) {
  const stale = outputs.filter(([file, text]) => !existsSync(file) || readFileSync(file, 'utf8') !== text).map(([f]) => f);
  if (missing.length) console.error(`No one-line summary in tools/gen-tools.mts for: ${missing.join(', ')}`);
  if (stale.length) console.error(`Stale (run tools/gen-tools.mts): ${stale.join(', ')}`);
  if (stale.length || missing.length) process.exit(1);
  console.log(`tools.json and manifest.json match Spredin Pro ${version} (${tools.length} tools).`);
} else {
  for (const [file, text] of outputs) writeFileSync(file, text);
  if (missing.length) console.error(`Warning: no one-line summary for ${missing.join(', ')}; used the first sentence. Add one to SUMMARY.`);
  console.log(`Wrote server/tools.json and manifest.json from Spredin Pro ${version}: ${tools.length} tools.`);
}
