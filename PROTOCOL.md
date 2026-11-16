# Spredin connector protocol, version 1

Status: draft until Spredin Pro 1.0.4 ships; then frozen. A change after that
raises the `connector` number in `GET /spredin`.

How an AI app on the same computer (Claude Desktop, through this extension)
talks to Spredin Pro. Spredin Pro is the server; the extension is a small
bridge that Claude Desktop starts, speaking MCP over stdio to Claude and
plain HTTP to Spredin.

```text
Claude Desktop ── MCP (stdio) ──▶ extension (server/index.js) ── HTTP, 127.0.0.1 ──▶ Spredin Pro
                                                                   │
                                                                   └─ the open workbook window
                                                                      (approval cards, History)
```

## Off by default

Spredin listens only while **Settings → Connect AI Apps → Allow AI apps on
this Mac to connect** is on. Off, nothing listens and the extension says
Spredin cannot be reached.

## Where Spredin listens

- Address `127.0.0.1` only, the first free port of **41870–41877**.
- The extension finds it by asking `GET /spredin` on every port of the range
  (300 ms each, all at once) and trying the ports that answer as below, lowest
  first. An answer to `GET /spredin` proves nothing: anything can send it.
  What counts is a signed answer (below).

## Every request

Spredin refuses, with `403`:

- a request with an `Origin` header, or with any `Sec-Fetch-*` header (web
  browsers send these, also for an image or a script tag; the extension never
  does);
- a request without the header `X-Spredin-Connector: 1` (a web page cannot
  add it without a preflight, which is refused);
- a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS
  rebinding).

Every error body is `{"error": "<code>", "message": "<words>"}`.

## `GET /spredin`

`200 {"app": "Spredin Pro", "connector": 1, "version": "1.0.4"}`. Says only
that something answering this way is listening.

## `POST /pair`

Asks the person, in Spredin's front workbook window, to allow the connection.
Waits for the answer, at most 180 s.

Request:

```json
{ "client": { "name": "Claude", "version": "…" },
  "connector": { "name": "spredin-connector", "version": "0.1.0" },
  "code": "K7QM2X" }
```

- `client.name` is what the AI app called itself in MCP `initialize`; Spredin
  shows it as the app's claim, cleaned.
- `code` is six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no
  look-alikes), fresh for each request. The extension has Claude show it in
  the chat; Spredin's sheet shows the code it received ("K7Q-M2X") and asks the
  person to allow only if Claude shows the same. A request without a valid
  code is `400`.
- The extension's tool call that starts a pairing comes back with the code
  after 1.5 s, since the person must see it before they can compare. The
  call Claude makes after showing it waits for this request's answer (up to
  its 190 s), sending MCP progress notices every 15 s, and goes on when the
  person allows.

Answers:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"token": "<64 hex>", "id": "<pairing id>"}` | Allowed. |
| 400 | `bad-request` | Not the JSON above, or no valid code. |
| 403 | `declined` | The person said no (or closed the window that asked). |
| 408 | `timeout` | Nobody answered within 180 s. |
| 409 | `busy` | Another request is being asked now. |
| 429 | `wait` | Declined or unanswered less than 60 s ago. |
| 503 | `no-window` / `stopped` | No workbook window to ask in / the connector was turned off while asking. |

The token is the pairing's secret. **It is never sent again.** Both sides use
`K = SHA-256(token)` (32 raw bytes) as the key for every request and answer.
Spredin keeps only `K`, in a file only the user can read; the extension keeps
the token, likewise.

## `POST /mcp`: signed requests, signed answers

Body: one JSON-RPC 2.0 message or a batch. Headers:

```text
X-Spredin-Connector: 1
X-Spredin-Pairing:   <pairing id>
X-Spredin-Time:      <milliseconds since 1970, decimal>
X-Spredin-Nonce:     <32 hex digits, fresh for every request>
X-Spredin-Mac:       hex(HMAC-SHA256(K, "req\n" + port + "\n" + id + "\n" + time + "\n" + nonce + "\n" + hex(SHA-256(body))))
```

`port` is the port the request is sent to, in decimal. Spredin refuses with
`401 unpaired` (unsigned) an unknown pairing, a time more than 120 s from its
own clock, a nonce it has seen in the last 10 minutes, or a MAC that does not
match.

A request body is at most 2 MB (2,097,152 bytes). Spredin refuses a larger one
with `413` before reading it, unsigned, since nothing of it was checked; the
extension never sends one (it tells Claude the request is too large), and
reads an unsigned `413` as "too large", not as another program answering.
Spredin also closes a connection that has not sent its request headers within
15 s, and keeps at most 32 connections open at once.

Every answer to a request that passed carries

```text
X-Spredin-Mac: hex(HMAC-SHA256(K, "res\n" + port + "\n" + nonce + "\n" + status + "\n" + hex(SHA-256(answer body))))
```

with the request's own nonce and the status code in decimal. The extension
uses an answer only when this matches.

Why: the token never crosses the wire, so a program that answers on a port
first (another user's on a shared Mac, a container's published port) learns
nothing it can use; it cannot forge an answer; and because the port is inside
both MACs, it cannot pass a request on to the real Spredin listening on
another port and hand back the real answer.

Answer bodies: one JSON-RPC response or an array, or `202` with an empty body
(signed all the same) when every message was a notification.

Methods:

- `initialize`: `serverInfo` `{name: "spredin-pro", version}`, capabilities
  `{tools: {listChanged: false}}`, and short `instructions`.
- `ping`.
- `tools/list`: the tools of the workbook the calls act on (below), plus
  `list_workbooks` and `use_workbook`.
- `notifications/cancelled` `{requestId}`: withdraws that call (its approval
  card goes away; nothing is changed). So does hanging up on a request.
- `tools/call`: `{name, arguments}`. Answer: an MCP tool result
  `{content: [{type: "text", text}], isError}`. A change can wait for the
  person's approval (below), so a call may take minutes; Spredin gives up
  after 900 s and says nothing was changed.

### Which workbook

The calls act on one workbook window: the one this pairing chose with
`use_workbook` while it is still open; otherwise the window in front;
otherwise any open workbook window. `list_workbooks` says which:

```text
Open workbooks (* = the one the tools act on):
* Budget 2026.sprd
  Sales.xlsx
```

`use_workbook {"name": "Sales"}` picks by name (exact, then the only name
containing it, ignoring case).

## The workbook's tools

The same tools as Spredin's own assistant: `describe_sheet`, `read_range`,
`aggregate`, `find`, `get_selection`, `write_cells`, `run_python`, `memory`,
`slides`, `python_help`. **Reads need no approval:** once an app is allowed,
it can read every open workbook (`use_workbook` chooses which). Changes —
`write_cells`, a script that writes, `memory` and `slides` edits — show an
approval card in Spredin, and each lands as ONE undo step, **unless the person
turned on "Apply assistant changes without asking"**; then they apply without
a card, except a script that reaches beyond the workbook (network, files,
printing), which still asks unless the person also turned on running such
scripts without asking. A memory change from an outside app always asks.

## What Spredin records

With Edit History on, a change made through the connector is recorded as the
app's: "Claude · connected", which tool, approved or applied without asking.
With History's "Record More Detail" on, its reads are noted too, and the
whole script or cell list it approved is kept with the step.

## The extension's own behaviour (not Spredin's)

- Talks only to `127.0.0.1`; never sends `Origin` or `Sec-Fetch-*`; always
  sends `X-Spredin-Connector: 1`.
- **Pairing.** Only when it has no pairing at all does a tool call start one
  by itself. Before pairing on macOS it checks that the program listening on
  the port runs under the user's own account (`lsof` lists only the user's
  own processes); if not, it pairs with nothing and says so. It makes a fresh
  code, tells Claude to show it, and sends it with `/pair`.
- **After a refusal** (any `401`, or an answer whose MAC does not match) it
  never pairs again by itself: it tells Claude that Spredin Pro does not accept
  this connection (disconnected in Spredin, or another program is answering)
  and pairs again only when Claude calls its `connect_spredin` tool, which the
  user must have asked for. So Disconnect sticks, and an impostor cannot make
  it pair.
- Keeps the token in a file only the user can read
  (`~/Library/Application Support/Spredin Connector/pairing.json` on macOS,
  `%APPDATA%\Spredin Connector\pairing.json` on Windows; the folder 0700, the
  file 0600, written through a randomly named temporary file created
  exclusively, then renamed).
- Offers its packaged copy of the tool list when Spredin cannot be reached,
  so Claude always knows the tools; a call then says how to reach Spredin.
- Writes nothing but its pairing file; logs only to stderr, never the token,
  a MAC, tool arguments or results.
