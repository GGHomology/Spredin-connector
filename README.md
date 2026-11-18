# Spredin Pro for Claude Desktop

This extension lets Claude Desktop work in [Spredin Pro](https://spredin.com),
the spreadsheet app, on your Mac. Claude can read the workbooks you have open
and change them. A change asks you in Spredin Pro first, unless you turned on
applying changes without asking.

It is a small bridge. Claude Desktop starts it, and it talks only to Spredin
Pro on this computer.

## Install

You need Spredin Pro 1.0.4 or later, and Claude Desktop.

1. Download `spredin-connector-<version>.mcpb` from the
   [latest release](https://github.com/GGHomology/Spredin-connector/releases/latest).
   The release notes give the file's SHA-256, if you want to check it.
2. Double-click it. Claude Desktop opens and offers to install it.

   Or, in Claude Desktop, choose **Settings → Extensions → Install Extension…**
   and pick the file.

There is nothing to set up in Claude Desktop.

## First use

1. In Spredin Pro, choose **Settings → Connect AI Apps** and turn on
   **Allow AI apps on this Mac to connect**. It is off until you do.
2. Open a workbook in Spredin Pro.
3. Ask Claude to do something with it, for example “What are the totals by
   region in my Sales sheet?”
4. The first time, Claude shows a code such as `K7Q-M2X` in its reply, and
   Spredin Pro asks **Allow Claude to use Spredin?** with a code too. Click
   Allow only if the two codes are the same. Don't Allow is the default.
   Claude waits for your answer and then carries on by itself.

After that:

- **Reading needs no approval.** An app you allowed can read every workbook
  you have open in Spredin Pro.
- **A change asks you first.** Writing cells, a script that writes, and
  changing slides show a card in the lower right of the Spredin Pro window,
  with Allow and Don't Allow. A change to the workbook's notes always asks.
- **Unless you turned that off.** With Spredin Pro's **Apply assistant changes
  without asking** on, changes apply without a card. A script that wants the
  network, a file or the printer still asks, unless you also allowed that.
- Each change is one undo step (⌘Z).

## What Claude can do

- See which workbooks are open, and choose the one to work in.
- Read a sheet's layout, a range of cells, and what you have selected.
- Find cells, and count, sum and average a table's columns.
- Write values and formulas into cells.
- Run Python on the workbook.
- Read and change the workbook's notes for the assistant.
- Read, change, present and export the workbook's slide decks.

## What Claude cannot do

- Open, save or close workbooks. It writes a file only where you choose:
  exporting slides opens Spredin Pro's save panel, and a script that writes a
  PDF asks you first.
- Read other files on your Mac, or other apps. A script that wants a file
  asks you first.
- Reach Spredin Pro when it is closed, or when Connect AI Apps is off. Claude
  will tell you that.
- Connect again by itself after you disconnect it. It connects again only if
  you ask, and you allow it in Spredin Pro.

## Privacy

- The extension talks only to Spredin Pro on this computer. It sends nothing
  to the internet.
- What Claude reads from your workbooks goes to Anthropic as part of your
  conversation, as with anything else you share in a Claude conversation.
- Nothing else is sent anywhere. The extension keeps one file, the pairing
  file (below). Its log says what happened, such as “paired” or an error. It
  never holds your data, the token, or what Claude asked for.

Spredin's privacy policy: <https://spredin.com/privacy>.

## Security

The full contract is [PROTOCOL.md](PROTOCOL.md). In short:

- **Local only.** The extension connects only to `127.0.0.1`, ports
  41870–41877, where Spredin Pro listens while Connect AI Apps is on. It asks
  every port at once and tries the ones that answer as Spredin, lowest first.
- **Web pages are kept out.** Spredin Pro refuses any request that comes from
  a web page. Every request from the extension says it is from the extension,
  and it never sends what a web page would send.
- **Pairing.** Your Allow gives the extension a token. It is kept only on this
  computer, in a file only your user account can read:
  - macOS: `~/Library/Application Support/Spredin Connector/pairing.json`
  - Windows: `%APPDATA%\Spredin Connector\pairing.json`

  The file is written whole, through a temporary file with a random name.
- **The token is never sent again.** Every request is signed with a key made
  from it, and every answer must carry Spredin Pro's signature. The port is
  part of both signatures. So another program answering on Spredin Pro's port
  learns nothing it can use, and cannot pass a request on to Spredin Pro on
  another port. The extension ignores any answer that is not signed, and sends
  nothing more to that port.
- **The code.** Each pairing request carries a fresh code. Spredin Pro shows
  it, and Claude shows it. Allow only if they match.
- **Who is listening (macOS).** Before it asks to pair, the extension runs
  `/usr/sbin/lsof` to check that the program on the port runs under your own
  user account. If not, it does not ask, and Claude tells you.
- **Disconnect sticks.** **Settings → Connect AI Apps** in Spredin Pro lists
  the apps you allowed, and Disconnect removes one. After that, or if Spredin
  Pro refuses the connection for any reason, the extension does not pair
  again by itself. It keeps its file, and Claude says so. Claude pairs again
  only through the extension's `connect_spredin` tool, when you ask it to.
- With Edit History on, Spredin Pro records each change made this way as
  Claude's.

More, including what this does not protect against, is in
[SECURITY.md](SECURITY.md).

## Remove it

In Claude Desktop, choose **Settings → Extensions** and remove Spredin Pro.
In Spredin Pro, Disconnect it under Settings → Connect AI Apps. You may also
delete the pairing file above.

## Windows

Planned. This same extension will work with Claude for Windows once Spredin
for Windows ships. The `lsof` check is macOS only, and Windows will need its
own check before then.

## For maintainers

The contract with Spredin Pro is [PROTOCOL.md](PROTOCOL.md). Spredin's side is
`src-tauri/src/connector.rs` and `src/connector/` in the Spredin Pro source.

| Path | What |
|---|---|
| `manifest.json` | The MCPB manifest (`manifest_version` 0.3). |
| `server/index.js` | The entry point Claude Desktop runs. |
| `server/connector.js` | Everything else. Node ≥ 18, no npm dependencies. |
| `server/tools.json` | The tool list Claude gets while Spredin cannot be reached. Generated. |
| `tools/gen-tools.mts` | Writes `server/tools.json` and the manifest's tool list from a Spredin Pro checkout. |
| `tools/pack.py` | Builds the `.mcpb` from the committed tree. Python 3, standard library, and git. |
| `test/` | `node:test` tests, with a fake Spredin and impostors. |

The server answers both kinds of MCP client. Older clients use `initialize`.
Clients of the 2026-07-28 revision send their version with each request.

The same server is the Spredin Pro plugin's (GGHomology/Spredin-plugin, which
copies `server/` and `package.json` from a commit here). The plugin's
`.mcp.json` sets `SPREDIN_CONNECTOR_HOST=plugin`, which changes only how the
server tells the user to update it; it is not a test hook.

### After each Spredin Pro release

Regenerate the tool list. Run this from the Spredin Pro checkout, which needs
its `node_modules`:

```sh
cd ../spredin-pro
node_modules/.bin/vite-node ../spredin-connector/tools/gen-tools.mts
```

Or, from here, run `npm run gen-tools`. That uses `../spredin-pro`, or the
folder in `SPREDIN_SRC`. Add `--check` (or run `npm run gen-tools:check`) to
change nothing and fail if the files are stale. A new Spredin tool also needs
its one-line summary added to `SUMMARY` in `tools/gen-tools.mts`.

### Test

```sh
npm test
```

The tests start the server as a child process, talk to it over stdin and
stdout, and run a fake Spredin and impostors on random ports. They never touch
Spredin's real ports or your pairing file. The packing tests need `python3`
and `git`. The generator check runs only when a Spredin Pro checkout is next
to this one.

These variables exist for the tests. The extension ignores them unless
`SPREDIN_CONNECTOR_TEST=1` is also set and it was started with the
`--test-hooks` argument (the tests' harness does both; no shipped config
passes the argument):

| Variable | Meaning |
|---|---|
| `SPREDIN_CONNECTOR_PORTS` | Ports to look on, e.g. `45000-45007`. |
| `SPREDIN_CONNECTOR_PAIRING_FILE` | Where the pairing file goes. |
| `SPREDIN_CONNECTOR_PAIR_WAIT_MS` | How long a call waits for Spredin's first answer to a pairing request (1.5 s). |
| `SPREDIN_CONNECTOR_PAIR_ANSWER_WAIT_MS` | How long a call made after the code was given waits for the person's answer (190 s). |
| `SPREDIN_CONNECTOR_PROGRESS_MS` | How often progress is reported (15 s). |
| `SPREDIN_CONNECTOR_LSOF` | A program to run in place of `/usr/sbin/lsof`. |
| `SPREDIN_CONNECTOR_PLATFORM` | The system to act as if on, e.g. `linux` (on a system Spredin Pro does not run on, every call says so). |

### Release

1. Set the same new version in `manifest.json` and `package.json`, and commit.
2. Run `npm test`.
3. Tag the commit, e.g. `git tag v0.1.0`.
4. Run `npm run pack`. It builds `dist/spredin-connector-<version>.mcpb` from
   the committed tree (it refuses uncommitted changes), and prints the commit
   and the file's SHA-256.
5. Optionally, sign it with a certificate: `mcpb sign
   dist/spredin-connector-<version>.mcpb --cert cert.pem --key key.pem`
   (from `@anthropic-ai/mcpb`). This is the owner's step, with the owner's
   certificate. Check it with `mcpb verify`. Signing changes the file, so take
   the SHA-256 after signing.
6. Make a GitHub release from the tag. Attach the `.mcpb`, and put its
   SHA-256 in the release notes. Spredin Pro's Settings links to the latest
   release.

## Licence

MIT. See [LICENSE](LICENSE).
