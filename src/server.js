#!/usr/bin/env node
/**
 * agy-mcp-server — exposes Google's Antigravity CLI (`agy`) as MCP tools.
 *
 * Transport: stdio (the MCP host spawns this process).
 *
 * Tools:
 *   agy_ask           ask the agent (persistent conversation)
 *   agy_ask_new       ask in a fresh conversation (becomes the new default)
 *   agy_resume        resume a conversation by id (ours or agy's)
 *   agy_conversations list live conversations
 *   agy_stop          close a conversation's agent process (kept resumable)
 *   agy_models        model ids agy supports
 *   agy_status        version, login, configuration, conversations
 *
 * IMPORTANT: stdout is the MCP protocol channel. All diagnostics go to
 * stderr.
 */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { ConversationManager } from "./conversations.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

function errorText(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `agy error: ${msg}` }], isError: true };
}

function log(...args) {
  console.error("[agy-mcp]", ...args);
}

function progressToken(extra) {
  return extra?._meta?.progressToken;
}

async function announce(extra, token, progress, message) {
  if (!config.progress || token === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    });
  } catch {
    /* hosts are free to ignore progress */
  }
}

function clamp(s, n = 500) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function formatResult(res) {
  const lines = [];

  if (res.status && res.status !== "SUCCESS") {
    lines.push(`[${res.status}]${res.error ? " " + res.error : ""}`);
  }
  for (const d of res.deniedActions || []) {
    lines.push(`denied: ${d.action ?? d.display_name ?? JSON.stringify(d)}`);
  }

  let body;
  if (res.structuredOutput != null) {
    body = JSON.stringify(res.structuredOutput, null, 2);
  } else {
    body = res.response || res.error || "";
  }
  if (!body) body = "(the agent returned no text)";
  lines.push(body);

  const meta = [];
  if (res.conversationId) meta.push(`conversation_id=${res.conversationId}`);
  if (res.agyConversationId) meta.push(`agy_conversation_id=${res.agyConversationId}`);
  if (res.durationSeconds != null) meta.push(`duration=${res.durationSeconds}s`);
  if (res.numTurns != null) meta.push(`turns=${res.numTurns}`);
  const u = res.usage || {};
  const pt = u.input_tokens ?? u.prompt_tokens;
  const ct = u.output_tokens ?? u.completion_tokens;
  if (pt != null || ct != null) meta.push(`tokens=${pt ?? "?"}/${ct ?? "?"}`);
  if (res.toolsUsed?.length) {
    meta.push(`tools_used=${res.toolsUsed.map((t) => t.tool).join(",")}`);
  }
  if (meta.length) lines.push("", "---", meta.join(" "));

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: res.status !== "SUCCESS",
  };
}

function makeAskHandler(manager, { fresh = false } = {}) {
  return async (args, extra) => {
    const token = progressToken(extra);
    let n = 0;
    const onDelta = (delta) => {
      n += 1;
      void announce(extra, token, n, clamp(delta));
    };

    void announce(extra, token, 0, fresh ? "starting a new conversation" : "starting agy turn");

    try {
      const res = await manager.ask({
        question: args.question,
        conversationId: args.conversation_id,
        fresh,
        workspace: args.workspace,
        model: args.model,
        effort: args.effort,
        mode: args.mode,
        timeoutMs: args.timeout ? Math.round(args.timeout * 1000) : undefined,
        onDelta,
      });
      return formatResult(res);
    } catch (err) {
      return errorText(err.conversationId ? `${err.message} (conversation ${err.conversationId})` : err);
    }
  };
}

// ---------------------------------------------------------------------------
// models (cached)
// ---------------------------------------------------------------------------

const modelsCache = { at: 0, ids: [] };

async function agyModels() {
  if (modelsCache.ids.length && Date.now() - modelsCache.at < 300_000) {
    return modelsCache.ids;
  }
  try {
    const { stdout } = await execFileAsync(config.bin, ["models"], {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const ids = stdout
      .split("\n")
      .map((l) => l.split("\t")[0].trim())
      .filter(Boolean);
    modelsCache.ids = ids;
    modelsCache.at = Date.now();
    return ids;
  } catch (err) {
    throw new Error(
      `could not list models (is agy installed and logged in?): ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function agyVersion() {
  try {
    const { stdout } = await execFileAsync(config.bin, ["--version"], {
      timeout: 30_000,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

function readAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.tokenFile, "utf8"));
    const token = raw.token || {};
    return {
      email: raw.id_token_email || "(unknown)",
      auth_method: raw.auth_method || "(unknown)",
      expiry: token.expiry || null,
      has_refresh_token: Boolean(token.refresh_token),
    };
  } catch {
    return { email: null, note: `no readable token at ${config.tokenFile}` };
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function createServer() {
  const manager = new ConversationManager();
  manager.start();

  const server = new McpServer({ name: config.name, version: config.version });

  const commonInput = {
    workspace: z
      .string()
      .optional()
      .describe("Directory for the agent to work in (default: AGY_WORKSPACE or the server cwd)."),
    model: z.string().optional().describe("Model id, see agy_models (default: AGY_MODEL)."),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("Reasoning effort (default: AGY_EFFORT)."),
    mode: z
      .enum(["accept-edits", "auto", "plan"])
      .optional()
      .describe("Agent execution mode (default: AGY_MODE)."),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe("Turn timeout in seconds (default: AGY_ASK_TIMEOUT)."),
  };

  server.registerTool(
    "agy_ask",
    {
      title: "Ask the Antigravity agent",
      description:
        "Ask Google's Antigravity agent a question in the current persistent " +
        "conversation. The agent keeps its memory across calls; it can use its " +
        "native tools (shell, files, browser, web search) and any MCP servers " +
        "registered in agy. Returns the agent's final answer.",
      inputSchema: {
        question: z.string().min(1).describe("The prompt/question for the agent."),
        conversation_id: z
          .string()
          .optional()
          .describe(
            "Conversation to use (default: the current default). Pass an agy " +
              "conversation UUID to resume a conversation from disk.",
          ),
        ...commonInput,
      },
    },
    makeAskHandler(manager),
  );

  server.registerTool(
    "agy_ask_new",
    {
      title: "Ask the Antigravity agent (new conversation)",
      description:
        "Same as agy_ask but starts a fresh conversation with no prior " +
        "context. The previous default conversation stays alive and can be " +
        "resumed with agy_resume.",
      inputSchema: {
        question: z.string().min(1).describe("The prompt/question for the agent."),
        ...commonInput,
      },
    },
    makeAskHandler(manager, { fresh: true }),
  );

  server.registerTool(
    "agy_resume",
    {
      title: "Resume an Antigravity conversation",
      description:
        "Continue a previous conversation by id. Accepts either a conversation " +
        "id returned by agy_ask/agy_ask_new or an agy conversation UUID (as " +
        "shown in agy_conversations / agy's history).",
      inputSchema: {
        conversation_id: z
          .string()
          .min(1)
          .describe("Conversation id (ours) or agy conversation UUID (from disk)."),
        question: z.string().min(1).describe("The follow-up prompt."),
        ...commonInput,
      },
    },
    async (args, extra) => {
      const token = progressToken(extra);
      let n = 0;
      const onDelta = (delta) => {
        n += 1;
        void announce(extra, token, n, clamp(delta));
      };
      try {
        const res = await manager.ask({
          question: args.question,
          conversationId: args.conversation_id,
          workspace: args.workspace,
          model: args.model,
          effort: args.effort,
          mode: args.mode,
          timeoutMs: args.timeout ? Math.round(args.timeout * 1000) : undefined,
          onDelta,
        });
        return formatResult(res);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "agy_conversations",
    {
      title: "List Antigravity conversations",
      description:
        "List the live conversations managed by this MCP server: ids, " +
        "workspace, model, agy conversation id, and last use.",
      inputSchema: {},
    },
    async () => {
      const list = manager.list();
      return text(JSON.stringify(list, null, 2));
    },
  );

  server.registerTool(
    "agy_stop",
    {
      title: "Stop an Antigravity conversation process",
      description:
        "Close the agent process for a conversation to free memory. The " +
        "conversation's memory stays on disk and can be resumed later with " +
        "agy_resume. Defaults to the current default conversation.",
      inputSchema: {
        conversation_id: z
          .string()
          .optional()
          .describe("Conversation id to stop (default: the current default)."),
      },
    },
    async (args) => {
      const id = args.conversation_id || manager.defaultId;
      const stopped = await manager.stop(id);
      return text(
        stopped
          ? `stopped conversation '${id}' (resumable with agy_resume)`
          : `conversation '${id}' is not active`,
      );
    },
  );

  server.registerTool(
    "agy_models",
    {
      title: "List Antigravity models",
      description: "List the model ids the installed agy supports (cached 5 min).",
      inputSchema: {},
    },
    async () => {
      try {
        const ids = await agyModels();
        if (!ids.length) {
          return text(
            "No models returned. Is agy logged in? Run `agy models` in a terminal.",
          );
        }
        return text(ids.join("\n"));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "agy_status",
    {
      title: "Antigravity status",
      description:
        "Report agy version, the signed-in account, configuration in effect, " +
        "and the live conversations managed by this server.",
      inputSchema: {},
    },
    async () => {
      const version = await agyVersion();
      const auth = readAuth();
      const convs = manager.list();
      const lines = [
        `agy version : ${version}`,
        `logged in as: ${auth.email ?? "(unknown)"}` +
          (auth.auth_method ? ` (${auth.auth_method})` : ""),
        auth.expiry ? `token expiry: ${auth.expiry}` : auth.note || "",
        "",
        `server      : ${config.name} v${config.version}`,
        `agy binary  : ${config.bin}`,
        `workspace   : ${config.workspace}`,
        `model       : ${config.model || "(agy default)"}`,
        `effort      : ${config.effort || "(agy default)"}`,
        `mode        : ${config.mode || "(agy default)"}`,
        `allow rules : ${config.allow.join(", ") || "(none)"}`,
        `deny rules  : ${config.deny.join(", ") || "(none)"}`,
        `skip perms  : ${config.skipPermissions}`,
        `ask timeout : ${Math.round(config.askTimeoutMs / 1000)}s`,
        `idle TTL    : ${Math.round(config.idleTtlMs / 1000)}s`,
        `env file    : ${config.envFile || "(none)"}`,
        "",
        `conversations (${convs.length}):`,
        ...convs.map(
          (c) =>
            `  - ${c.id}${c.is_default ? " (default)" : ""} ` +
            `[${c.active ? "running" : "hibernated"}] ` +
            `agy=${c.agy_conversation_id ? c.agy_conversation_id.slice(0, 8) : "-"} ` +
            `last_used=${c.last_used}`,
        ),
      ].filter(Boolean);
      return text(lines.join("\n"));
    },
  );

  // Stop the agent processes when the host disconnects.
  server.server.onclose = () => {
    void manager.closeAll();
  };

  return { server, manager };
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

export async function main() {
  const { server, manager } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(
    `ready name=${config.name} v${config.version} bin=${config.bin} ` +
      `workspace=${config.workspace} progress=${config.progress}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, closing conversations`);
    try {
      await manager.closeAll();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Last resort: never leave orphaned agy processes behind.
  process.on("exit", () => manager.closeAllSync());
}
