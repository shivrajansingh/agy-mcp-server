# agy-mcp-server — Detailed Plan

**Goal:** expose Google's Antigravity CLI (`agy`) as a standard MCP server, so
any MCP host — OpenCode, Claude Desktop, LibreChat, the MCP Inspector — can
call the Antigravity *agent* as a tool, with persistent conversational memory.

Sibling project: `/root/ssd/Projects/agy-openai` (OpenAI-compatible facade over
agy). This project is the MCP-native equivalent.

---

## 1. Architecture

```
MCP host (OpenCode, Claude Desktop, Inspector, any MCP client)
        │  stdio (JSON-RPC 2.0, MCP spec)
        ▼
agy-mcp-server  (this project — FastMCP, Node.js, official MCP TypeScript/JS SDK)
        │  reuses agyq.AgySession  (loaded as a module from ~/.local/bin/agyq)
        ▼
agy process  (--input-format stream-json --output-format stream-json)
        │  gRPC to Google language server
        ▼
Antigravity agent (Gemini 3.x) — with native tools, agy-registered MCP servers
```

Key decisions (confirmed with the user):

| Decision | Choice |
|---|---|
| Direction | **A**: agy *as* an MCP server (facade), not tools provided *to* agy |
| Transport | **stdio only** — the host spawns us as a subprocess, zero-config |
| Conversations | **Persistent** — long-lived `agy` process per conversation, memory kept |

## 2. The one big semantic difference vs agy-openai

In agy-openai, tools declared by the API client are **relayed back to the
client** over HTTP (`mcp_bridge.py` blocks on `/internal/tool-call`). An MCP
server has **no way to synchronously call a tool back into its host** — the MCP
spec only offers sampling (LLM calls), not tool relaying.

Consequences:

* The agent's tools here are: its **native tools** (`run_command`,
  `write_to_file`, `browser_*`, `search_web`, …) plus any MCP servers
  registered in agy itself (`agy mcp add`) — all executed on this machine.
* `ask_user` is **not exposed**. There is nobody to answer it synchronously.
  (Optional later: emulate it with MCP *sampling* — ask the host's LLM —
  but that is phase 2 and off by default.)
* Everything runs in "server" execution mode; the `client` mode from
  agy-openai does not apply here.

## 3. Tool surface (MCP tools we expose)

| Tool | Purpose |
|---|---|
| `agy_ask` | Ask the agent in the current conversation (created lazily). Params: `question` (required), `model`, `effort` (`low/medium/high/xhigh/max`), `mode` (`accept-edits/auto/plan`), `timeout` (seconds). |
| `agy_ask_new` | Same, but in a **fresh** conversation (drops nothing — the old one stays alive and resumable). |
| `agy_resume` | Resume a named/previous agy conversation: `conversation_id` + `question`. |
| `agy_conversations` | List live conversations in this server (id, workspace, model, last used, agy conversation id). |
| `agy_stop` | Kill one conversation's agy process (free memory; memory is still on disk and resumable via `agy_resume`). |
| `agy_models` | List model ids agy supports (cached). |
| `agy_status` | Liveness: agy version, logged-in account, live conversations, uptime. |

Schema notes:

* `agy_ask` also accepts an optional `conversation_id` so a host can address
  several conversations from one MCP connection.
* Every tool returns `{ text: ... }` content; `agy_ask` returns the agent's
  final text plus a short footer line:
  `conversation_id=<id> agy_conversation_id=<id>` so the host can resume later.

## 4. Conversation model

* One MCP session == one server process == its own `SessionManager`
  (borrowed/adapted from agy-openai `sessions.py`).
* A "default" conversation is created lazily on the first `agy_ask`.
  `agy_ask_new` rotates it: the current default becomes just another named
  conversation, still resumable.
* Each `Conversation` = one `agyq.AgySession` = one long-lived agy process
  speaking stream-json; conversation memory survives across tool calls, and
  process restarts resume the same agy conversation id from disk.
* A **per-conversation asyncio.Lock** serializes turns: agy's stream-json is
  strictly sequential, so a second concurrent `agy_ask` on the same
  conversation waits (with a timeout error message) rather than interleaving.
* Idle reaping: conversations unused for `AGY_IDLE_TTL` (default 30 min) have
  their process closed (memory persists on disk; `agy_resume` brings it back).
* No PID↔conversation bridge mapping needed here — that machinery existed only
  because agy-openai needed to identify which conversation a spawned MCP
  bridge belonged to.

## 5. Streaming (phase 1.5 — optional but cheap)

MCP supports progress notifications during a `tools/call`:

* `AgySession.on_event` already yields `agent_response` text deltas
  (agy-openai used this for SSE).
* Map deltas to `notifications/progress` messages with the request's
  progress token, so hosts that display progress can show the answer as it
  streams. The final result is still the complete text.
* Behind an env flag `AGY_MCP_PROGRESS=1` (default on), harmless if a host
  ignores it.

## 6. Configuration

Same pattern as agy-openai: a single `.env`, loaded by the server
(`python-dotenv`, fallback parser), values already in the environment win.

| Variable | Default | Meaning |
|---|---|---|
| `AGY_MCP_NAME` | `agy-mcp-server` | serverInfo.name |
| `AGY_BIN` | `/root/.local/bin/agy` | agy binary |
| `AGYQ_PATH` | `/root/.local/bin/agyq` | wrapper imported as a module |
| `AGY_WORKSPACE` | server cwd | default workspace for conversations |
| `AGY_MODEL` | *(empty)* | default model id |
| `AGY_EFFORT` | *(empty)* | default reasoning effort |
| `AGY_MODE` | *(empty)* | default agent mode |
| `AGY_ALLOW` | `command(*),mcp(*)` | agy permission allow-rules |
| `AGY_DENY` | *(empty)* | agy permission deny-rules |
| `AGY_SKIP_PERMISSIONS` | `0` | `1` = `--dangerously-skip-permissions` |
| `AGY_ASK_TIMEOUT` | `900` | max seconds for one agent turn |
| `AGY_IDLE_TTL` | `1800` | close idle conversation processes after N sec |
| `AGY_MAX_CONVERSATIONS` | `8` | LRU cap on live conversations |
| `AGY_MCP_PROGRESS` | `1` | stream text deltas as progress notifications |

## 7. File layout

| File | Role |
|---|---|
| `PLAN.md` | this document |
| `src/server.js` | MCP server: tool defs, wiring, entrypoint (stdio) |
| `src/agy-session.js` | Node port of `agyq.AgySession` — one `agy` process speaking stream-json |
| `src/conversations.js` | Conversation + manager: serialization, idle TTL, LRU cap, resume |
| `src/config.js` | `.env` + environment configuration |
| `bin/agy-mcp-server.js` | executable entrypoint (package `bin`) |
| `.env.example` | configuration template |
| `README.md` | usage: registering with OpenCode, Claude Desktop, Inspector |
| `test/test-smoke.mjs` | live round-trip: start session, ask, verify reply |
| `test/test-tools.mjs` | calls every tool through an in-memory MCP client session |

Dependencies (Node ≥ 20): `@modelcontextprotocol/sdk`, `zod`, `dotenv`.
Plain ESM JavaScript — no build step, no TypeScript toolchain.

## 8. Registration (documented in README)

**OpenCode** (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "agy": {
    "type": "local",
    "command": ["python3", "/root/ssd/Projects/agy-mcp-server/agy_mcp_server.py"] } } }
```

**Claude Desktop** (`claude_desktop_config.json`): same command as
`mcpServers.agy`.

**Inspector / ad-hoc testing:**

```bash
npx @modelcontextprotocol/inspector python3 agy_mcp_server.py
```

## 9. Implementation order

1. [x] `src/agy-session.js` — Node port of `AgySession` (stream-json reader,
       `ask()` promise, `init`/`result` events, SIGTERM→SIGKILL close).
2. [x] `src/conversations.js` — Conversation manager: per-conv serialization,
       idle TTL reaper, LRU cap, crash-restart with memory resume.
       Dropped from the Python version: PendingCall/OpenAI relay, execution
       modes, PID mapping (not applicable in MCP).
3. [x] `src/server.js` + `bin/` — MCP server, the 7 tools, graceful shutdown.
4. [x] `.env.example` + npm scripts (`npm test`, `npm start`).
5. [x] `test/test-smoke.mjs` — real agy round-trip (needs login).
6. [x] `test/test-tools.mjs` — every tool via an in-memory MCP client.
7. [x] `README.md` + registration for OpenCode/Claude Desktop.
8. [ ] (opt) sampling-based `ask_user`.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| agy captures MCP tool list at process start | not our problem here: the tools the *agent* sees are agy-native; we only change our own tool surface |
| One turn at a time per agy process | per-conversation asyncio.Lock; concurrent calls wait or time out with a clear message |
| Host disconnects but agy processes linger | atexit + SIGTERM handler closes all sessions; idle TTL reaper as backstop |
| Long turns exceed a host's tool timeout | `AGY_ASK_TIMEOUT` + configurable per-call `timeout`; progress notifications keep hosts from killing the call |
| `agyq` is a moving file at `~/.local/bin/agyq` | version-check via `agy --version` on startup; `agy_status` reports it; loader errors produce a readable MCP error |
| Login expiry mid-session | `agy_status` reads the oauth token file's email/expiry; ask failures surface agy's "not logged in" error verbatim |
| Secrets in `.env` | `.env` is gitignored; `.env.example` carries placeholders |
