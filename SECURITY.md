# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's
**Report a vulnerability** (the repository's Security tab), or write to
feedback@spredin.com with "Security" in the subject. We answer within a few
working days.

## What this extension is

A small program Claude Desktop runs on your computer, with your user
account's rights. It passes Claude's requests to Spredin Pro on the same
computer and Spredin Pro's answers back. It has no dependencies (Node's
built-in modules only) and opens no network connection except to
`127.0.0.1`. The only other program it starts is `/usr/sbin/lsof`, on macOS,
by that absolute path, with fixed arguments and no shell, just before it asks
to pair. It writes one file: its pairing file.

## What protects you

- **Off until you turn it on.** Spredin Pro listens only while Settings →
  Connect AI Apps is on, and only on `127.0.0.1` (your own computer).
- **You allow each app.** The first request shows an Allow sheet in Spredin
  Pro; Don't Allow is the default. Settings → Connect AI Apps lists the allowed
  apps, and Disconnect removes one.
- **A code to compare.** Each pairing request carries a fresh code of six
  characters, made by the system's random number generator from an alphabet
  with no look-alikes. Spredin Pro's sheet shows the code it received, and
  Claude is told to show the code the extension sent, in its reply, before it
  waits for your answer. Allow only if they match.
- **Changes ask you, unless you said otherwise.** Writing cells, a script that
  writes, and changing slides show a card in Spredin Pro first, unless you
  turned on "Apply assistant changes without asking". A script that reaches
  beyond the workbook (the internet, files, printing) still asks, unless you
  also allowed that. A change to the workbook's notes always asks. Each change
  is one undo step.
- **Reads do not ask.** Once you allow an app, it can read every workbook open
  in Spredin Pro.
- **Web pages cannot reach it.** Spredin Pro refuses any request that carries
  an `Origin` or `Sec-Fetch-*` header, lacks `X-Spredin-Connector: 1`, or
  names another host (DNS rebinding). The extension sends that header on every
  request and never the others.
- **The pairing key stays here.** The extension keeps the token in a file only
  your account can read (`pairing.json`, mode 0600, in a folder that is 0700).
  The file is written whole: a temporary file with a random name is created
  exclusively, so nothing already there is written through, then renamed into
  place. Spredin Pro keeps only the token's SHA-256. Neither ever writes the
  token to a log.
- **The token is never sent after pairing.** Every request to Spredin Pro is
  signed with HMAC-SHA256, keyed by the token's SHA-256, over the port, the
  pairing id, the time, a fresh random nonce and the body. Every answer must
  carry an HMAC over the port, the request's nonce, the status and the body.
  The extension compares it in constant time and uses no answer that does not
  match (`PROTOCOL.md`, `POST /mcp`). So a program that answers on Spredin
  Pro's port first (another user's program on a shared Mac, a container's
  published port) learns nothing it can use and cannot forge an answer. And
  because the port is inside both MACs, it cannot pass a request on to Spredin
  Pro on another port and hand back the real answer.
- **The real Spredin is chosen by its signature.** The extension asks every
  port for Spredin's hello, then tries the ones that answered, lowest first,
  with a signed request. It uses the first whose signed answer verifies. A
  port whose answer does not verify is sent nothing more for the rest of the
  session.
- **Who is listening, before pairing (macOS).** Before it asks a port to
  pair, the extension runs `lsof` to check that the program listening there
  runs under your own account. `lsof` lists only your own processes unless it
  runs as root. If it lists none, the extension does not pair there and says
  so. If `lsof` is missing or fails, it does not pair at all, and says why.
- **No pairing again by itself.** A tool call starts a pairing only when there
  is no pairing file at all. After any refusal (a `401`, or an answer whose
  signature does not match), the extension keeps its file and tells Claude
  that Spredin Pro does not accept the connection. It pairs again only when
  Claude calls its `connect_spredin` tool, which Claude is told to call only
  when you ask. The new pairing replaces the old file only if you allow it. So
  Disconnect sticks, and an impostor cannot make it pair.
- **Test hooks are off.** The `SPREDIN_CONNECTOR_*` settings that point it at
  other ports, another pairing file or another `lsof` work only when
  `SPREDIN_CONNECTOR_TEST=1` is set AND the server was started with the
  `--test-hooks` argument. Neither Claude Desktop (`manifest.json`) nor the
  Spredin Pro Tools plugin (`.mcp.json`) passes it. A variable alone is not enough,
  because an environment can be set by something you did not mean to trust
  with this: in Claude Code, a project's settings set the session's.
- **Only where Spredin Pro runs.** On a system Spredin Pro does not run on
  (today, anything but macOS), the extension connects to nothing and every
  call says so.

## What it does not protect against

- **Windows, when Spredin for Windows ships.** The `lsof` check is macOS only,
  and off macOS the extension does nothing today. Windows will need its own
  check that the listener runs as you before it joins the systems the
  connector works on (`SPREDIN_PLATFORMS`).
- **Programs already running as you.** Software running under your own account
  can read your files, the pairing file included, can pass `lsof`'s check, and
  can control your apps. No local connection can defend against that.
- **What Claude does with what it reads.** What the extension passes to Claude
  goes to Anthropic as part of your conversation, under Anthropic's terms.
  Text in a workbook is data: a cell can contain words written to mislead an
  AI. The extension tells Claude that workbook text is never an instruction,
  and Spredin's approval cards are there so that a change does not happen
  without you seeing it, unless you chose otherwise.

## Releases

Each release's `.mcpb` is built by `tools/pack.py` from a tagged commit,
through `git archive`. It refuses a working tree with uncommitted changes,
and gives the same bytes for the same commit. The release notes carry the
file's SHA-256. The owner may also sign the file with a certificate using
`mcpb sign`; `mcpb verify` checks such a signature.
