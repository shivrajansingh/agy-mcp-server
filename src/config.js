/**
 * Configuration for agy-mcp-server.
 *
 * Precedence: process environment > .env file > built-in defaults.
 *
 * The .env file is looked up in this order:
 *   1. $AGY_MCP_ENV_FILE
 *   2. ./.env            (working directory of the MCP host spawn)
 *   3. ../.env           (project root, next to package.json)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function loadEnvFile() {
  const candidates = [
    process.env.AGY_MCP_ENV_FILE,
    path.join(process.cwd(), ".env"),
    path.join(ROOT, ".env"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, override: false, quiet: true });
      return file;
    }
  }
  return null;
}

const envFile = loadEnvFile();

const env = process.env;

function seconds(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  // Accept plain seconds ("900") or a unit suffix ("15m", "2h", "90s").
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * mult);
}

function integer(name, fallback) {
  const n = parseInt(env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function splitRules(raw) {
  return String(raw ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Find the agy binary: $AGY_BIN, then $PATH, then ~/.local/bin/agy. */
function resolveAgyBin() {
  if (env.AGY_BIN) return env.AGY_BIN;
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, "agy");
    if (isExecutable(p)) return p;
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "agy");
  if (isExecutable(fallback)) return fallback;
  return "agy";
}

export const config = {
  /** serverInfo.name reported to MCP hosts */
  name: env.AGY_MCP_NAME || "agy",
  version: pkg.version,
  envFile,

  /** agy binary + defaults for conversations */
  bin: resolveAgyBin(),
  workspace: env.AGY_WORKSPACE || process.cwd(),
  model: env.AGY_MODEL || "",
  effort: env.AGY_EFFORT || "",
  mode: env.AGY_MODE || "",
  agent: env.AGY_AGENT || "",

  /** permission plan handed to agy via --settings */
  allow: splitRules(env.AGY_ALLOW ?? "command(*),mcp(*)"),
  deny: splitRules(env.AGY_DENY ?? ""),
  skipPermissions: env.AGY_SKIP_PERMISSIONS === "1",

  /** timeouts */
  askTimeoutMs: seconds("AGY_ASK_TIMEOUT", 900_000),
  busyTimeoutMs: seconds("AGY_BUSY_TIMEOUT", 120_000),
  idleTtlMs: seconds("AGY_IDLE_TTL", 1_800_000),
  maxConversations: integer("AGY_MAX_CONVERSATIONS", 8),

  /** stream agent text deltas as MCP progress notifications */
  progress: env.AGY_MCP_PROGRESS !== "0",

  /** where the oauth token lives (for agy_status) */
  tokenFile:
    env.AGY_TOKEN_FILE ||
    path.join(
      env.GEMINI_DIR || path.join(os.homedir(), ".gemini"),
      "antigravity-cli",
      "antigravity-oauth-token",
    ),
};

export default config;
