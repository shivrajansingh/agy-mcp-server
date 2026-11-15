# agy-mcp-server

An MCP server that exposes **Google's Antigravity CLI (`agy`)** as tools, so
any MCP host — OpenCode, Claude Desktop, Cursor, the MCP Inspector, your own
agent — can talk to the Antigravity agent.

```
MCP host (OpenCode / Claude Desktop / ...)
        │  stdio (JSON-RPC 2.0, MCP)
        ▼
agy-mcp-server ──▶ agy --input-format stream-json --output-format stream-json
        │                        │
        │                        ▼
        │              Antigravity agent (Gemini 3.x)
        │              + native tools (shell, files, browser, web search)
        │              + MCP servers registered in agy
        ▼
   persistent conversations, streamed progress
```

Companion project: [`agy-openai`](https://github.com/technicalheist) — the same
idea for the OpenAI Chat Completions format.

## Features

* **Persistent conversations** — one long-lived `agy` process per conversation,
  so the agent remembers context across tool calls. Conversations survive
  process restarts (agy persists them on disk and they are resumed by id).
* **Live progress** — agent text deltas are streamed to the host as MCP
  progress notifications while the turn runs.
* **Workspace / model / effort / mode per call** — override any of them on a
  single `agy_ask`.
* **Idle handling** — unused agent processes are closed after
  `AGY_IDLE_TTL`; memory stays resumable. Live conversations are capped by
  `AGY_MAX_CONVERSATIONS` (LRU).
* **No build step** — plain ESM JavaScript, Node ≥ 20.

## Tools

| Tool | What it does |
|---|---|
| `agy_ask` | Ask the agent in the current persistent conversation. |
| `agy_ask_new` | Ask in a fresh conversation (becomes the new default; the old one stays resumable). |
| `agy_resume` | Continue a conversation by our id **or** an agy conversation UUID. |
| `agy_conversations` | List live conversations (id, workspace, model, agy id, last use). |
| `agy_stop` | Close a conversation's agent process (still resumable). |
| `agy_models` | Model ids agy supports (cached 5 min). |
| `agy_status` | agy version, signed-in account, config, conversations. |

`agy_ask` example parameters:

```json
{
  "question": "Summarise the git history of this repo",
  "workspace": "/root/ssd/Projects/agy-mcp-server",
  "model": "gemini-3.8-flash-high",
  "effort": "high",
  "mode": "accept-edits",
  "timeout": 600
}
```

## Install

### From GitHub Packages

```bash
# one-time: tell npm where @technicalheist packages live
echo "@shivrajansingh:registry=https://npm.pkg.github.com" >> ~/.npmrc

# auth (a GitHub token with read:packages)
echo "//npm.pkg.github.com/:_authToken=$GITHUB_TOKEN" >> ~/.npmrc

npm install -g @shivrajansingh/agy-mcp-server
```

### From source

```bash
git clone https://github.com/shivrajansingh/agy-mcp-server.git
cd agy-mcp-server
npm install
```

## Configure

Copy `.env.example` to `.env` (next to `package.json`) or export the variables.
Environment wins over the file. Highlights:

| Variable | Default | Meaning |
|---|---|---|
| `AGY_BIN` | `agy` then `~/.local/bin/agy` | agy executable |
| `AGY_WORKSPACE` | server cwd | default workspace |
| `AGY_MODEL` / `AGY_EFFORT` / `AGY_MODE` | agy defaults | conversation defaults |
| `AGY_ALLOW` | `command(*),mcp(*)` | permission allow rules |
| `AGY_DENY` | *(empty)* | permission deny rules |
| `AGY_SKIP_PERMISSIONS` | `0` | `1` = `--dangerously-skip-permissions` |
| `AGY_ASK_TIMEOUT` | `900` | per-turn timeout (seconds) |
| `AGY_BUSY_TIMEOUT` | `120` | how long a second ask waits on a busy conversation |
| `AGY_IDLE_TTL` | `1800` | hibernation TTL for idle conversations |
| `AGY_MAX_CONVERSATIONS` | `8` | max live agent processes |
| `AGY_MCP_PROGRESS` | `1` | stream deltas as MCP progress notifications |

## Register with a host

### OpenCode

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agy": {
      "type": "local",
      "command": ["agy-mcp-server"],
      "environment": {
        "AGY_WORKSPACE": "/root/ssd/Projects"
      }
    }
  }
}
```

Or with an explicit path:

```json
"command": ["node", "/root/ssd/Projects/agy-mcp-server/bin/agy-mcp-server.js"]
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agy": {
      "command": "agy-mcp-server",
      "env": { "AGY_WORKSPACE": "/home/me/projects" }
    }
  }
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector \
  node /path/to/agy-mcp-server/bin/agy-mcp-server.js
```

## Requirements

* Node.js ≥ 20
* `agy` installed and logged in (`agy --version`, `agy models`). The server is
  verified against agy **1.5.5**; after `agy update`, re-check the stream-json
  contract with `agyq doctor` (the wrapper the protocol was reverse-engineered
  from).

## Notes and limits

* **One turn at a time per conversation.** agy's stream-json loop is strictly
  sequential; a second concurrent `agy_ask` waits up to `AGY_BUSY_TIMEOUT`.
  Use `agy_ask_new` for parallel work.
* **`ask_user` is not exposed.** An MCP server cannot synchronously call a tool
  back into its host, so there is nobody to answer. The agent either works it
  out or reports that it needs input.
* **The agent acts on the machine running this server.** Its native tools
  (shell, files, browser) and agy-registered MCP servers execute here. Use
  `AGY_ALLOW` / `AGY_DENY` to constrain it.
* Tool execution and model calls are billed by Google/Antigravity as usual;
  each turn is a full agent loop (seconds to tens of seconds).
* stdout carries the MCP protocol; all logs go to stderr.

## Development

```bash
npm install
npm run test:smoke                              # real agy round-trip
npm test                                        # tool surface via in-memory client
AGY_TEST_LIVE=1 npm test                        # + a real agy_ask turn
```

## License

MIT © [Technical Heist](https://github.com/technicalheist)
