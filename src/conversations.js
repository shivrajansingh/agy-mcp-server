/**
 * Conversation management for agy-mcp-server.
 *
 * One Conversation == one long-lived `agy` process (AgySession), so the
 * agent keeps its memory across tool calls. agy also persists conversations
 * on disk: if the process is closed (idle TTL, stop, crash) the same agy
 * conversation id is resumed by a fresh process.
 *
 * Turns on a conversation are strictly serialized: agy's stream-json loop is
 * one turn at a time, so a concurrent `agy_ask` waits (up to
 * AGY_BUSY_TIMEOUT) instead of interleaving.
 */
import { randomBytes } from "node:crypto";
import { AgySession } from "./agy-session.js";
import { config } from "./config.js";

export const DEFAULT_CONVERSATION_ID = "default";

export class Conversation {
  constructor(id) {
    this.id = id;
    this.session = null;
    this.agyConversationId = null;
    /** per-call overrides (reset to null when the session restarts) */
    this.workspace = null;
    this.model = null;
    this.effort = null;
    this.mode = null;
    this.created = Date.now();
    this.lastUsed = Date.now();
    this._busy = false;
  }

  get active() {
    return this.session != null;
  }

  ensureSession() {
    if (this.session) return this.session;
    this.session = new AgySession({
      bin: config.bin,
      workspace: this.workspace || config.workspace,
      conversation: this.agyConversationId || undefined,
      allow: config.allow,
      deny: config.deny,
      skipPermissions: config.skipPermissions,
      model: this.model || config.model || undefined,
      effort: this.effort || config.effort || undefined,
      agent: config.agent || undefined,
      mode: this.mode || config.mode || undefined,
    });
    this.session.on("evt", (ev) => {
      if (ev?.event === "init" && ev.conversation_id) {
        this.agyConversationId = ev.conversation_id;
      }
    });
    this.session.on("exit", () => {
      this.session = null;
    });
    return this.session;
  }

  /**
   * Run one turn, serialized against other turns on this conversation.
   * @param {string} question
   * @param {{timeoutMs?:number, onDelta?:(delta:string)=>void}} [opts]
   */
  async ask(question, { timeoutMs, onDelta } = {}) {
    const started = Date.now();
    while (this._busy) {
      if (Date.now() - started > config.busyTimeoutMs) {
        throw new Error(
          `conversation '${this.id}' is busy with another turn; ` +
            `wait for it to finish or use agy_ask_new`,
        );
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    this._busy = true;

    const onEvent = (ev) => {
      const su = ev?.step_update;
      if (su?.step_type === "agent_response" && su.text_delta && onDelta) {
        try {
          onDelta(su.text_delta);
        } catch {
          /* a bad progress consumer must not kill the turn */
        }
      }
    };

    try {
      const session = this.ensureSession();
      session.on("evt", onEvent);
      try {
        const res = await session.ask(question, timeoutMs);
        if (res.conversationId) this.agyConversationId = res.conversationId;
        return res;
      } finally {
        session.removeListener("evt", onEvent);
        this.lastUsed = Date.now();
        // a dead process is dropped so the next turn restarts & resumes
        if (!session.alive) this.session = null;
      }
    } finally {
      this._busy = false;
    }
  }

  /** Close the process but keep the conversation (memory is on disk). */
  async hibernate() {
    const session = this.session;
    this.session = null;
    if (session) await session.close();
  }

  closeSync() {
    const session = this.session;
    this.session = null;
    if (session) session.killNow();
  }

  info(defaultId) {
    return {
      id: this.id,
      is_default: this.id === defaultId,
      active: this.active,
      agy_conversation_id: this.agyConversationId,
      workspace: this.workspace || config.workspace,
      model: this.model || config.model || null,
      created: new Date(this.created).toISOString(),
      last_used: new Date(this.lastUsed).toISOString(),
    };
  }
}

export class ConversationManager {
  constructor() {
    /** @type {Map<string, Conversation>} */
    this.conversations = new Map();
    /** id -> agy conversation id for stopped/evicted conversations */
    this._closed = new Map();
    this.defaultId = DEFAULT_CONVERSATION_ID;
    this._reaper = null;
  }

  start() {
    if (this._reaper) return;
    this._reaper = setInterval(() => this._reapIdle(), 60_000);
    this._reaper.unref?.();
  }

  stopReaper() {
    if (this._reaper) clearInterval(this._reaper);
    this._reaper = null;
  }

  _get(id) {
    return this.conversations.get(id) || null;
  }

  _create(id) {
    if (this.conversations.size >= config.maxConversations) {
      this._evictOne();
    }
    const conv = new Conversation(id);
    this.conversations.set(id, conv);
    return conv;
  }

  /** Remember a closed conversation so its own id stays resumable. */
  _rememberClosed(conv) {
    if (!conv.agyConversationId) return;
    if (this._closed.size >= 100) {
      this._closed.delete(this._closed.keys().next().value);
    }
    this._closed.set(conv.id, conv.agyConversationId);
  }

  /** Close the least-recently-used idle conversation (kept resumable). */
  _evictOne() {
    let oldest = null;
    for (const c of this.conversations.values()) {
      if (c._busy || c.id === this.defaultId) continue;
      if (!oldest || c.lastUsed < oldest.lastUsed) oldest = c;
    }
    if (oldest) {
      this._rememberClosed(oldest);
      void oldest.hibernate();
      this.conversations.delete(oldest.id);
      return true;
    }
    return false;
  }

  _reapIdle() {
    const now = Date.now();
    for (const c of this.conversations.values()) {
      if (!c.active || c._busy) continue;
      if (now - c.lastUsed > config.idleTtlMs) void c.hibernate();
    }
  }

  /**
   * Ask in a conversation, creating or resuming it as needed.
   *
   * @param {object} args
   * @param {string} args.question
   * @param {string} [args.conversationId] existing conversation id, or an
   *        agy conversation id (UUID) to resume from disk
   * @param {boolean} [args.fresh] create a new conversation and make it default
   * @param {string} [args.workspace]
   * @param {string} [args.model]
   * @param {string} [args.effort]
   * @param {string} [args.mode]
   * @param {number} [args.timeoutMs]
   * @param {(delta:string)=>void} [args.onDelta]
   */
  async ask({ question, conversationId, fresh = false, workspace, model, effort, mode, timeoutMs, onDelta }) {
    let id = conversationId || this.defaultId;

    if (fresh) {
      id = `c-${randomBytes(4).toString("hex")}`;
      this.defaultId = id;
    }

    let conv = this._get(id);

    if (!conv) {
      conv = this._create(id);
      // Resume memory: a previously closed conversation's agy id, or an agy
      // conversation UUID passed directly.
      const remembered = this._closed.get(id);
      if (remembered) {
        conv.agyConversationId = remembered;
        this._closed.delete(id);
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        conv.agyConversationId = id;
      }
    }
    // per-call overrides apply to this conversation from now on
    if (workspace) conv.workspace = workspace;
    if (model) conv.model = model;
    if (effort) conv.effort = effort;
    if (mode) conv.mode = mode;

    const res = await conv.ask(question, {
      timeoutMs: timeoutMs ?? config.askTimeoutMs,
      onDelta,
    });
    return { ...res, conversationId: conv.id, agyConversationId: conv.agyConversationId };
  }

  list() {
    return [...this.conversations.values()].map((c) => c.info(this.defaultId));
  }

  async stop(id) {
    const conv = this._get(id || this.defaultId);
    if (!conv) return false;
    this._rememberClosed(conv);
    await conv.hibernate();
    this.conversations.delete(conv.id);
    if (this.defaultId === conv.id) this.defaultId = DEFAULT_CONVERSATION_ID;
    return true;
  }

  async closeAll() {
    this.stopReaper();
    const all = [...this.conversations.values()];
    this.conversations.clear();
    await Promise.all(all.map((c) => c.hibernate().catch(() => {})));
  }

  closeAllSync() {
    this.stopReaper();
    for (const c of this.conversations.values()) c.closeSync();
    this.conversations.clear();
  }
}

export default ConversationManager;
