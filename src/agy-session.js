/**
 * Node port of `agyq.AgySession` — owns one `agy` process speaking
 * stream-json over stdio, and turns a prompt into a `result` event.
 *
 * Contract (verified against agy 1.5.5; re-check with `agyq doctor` after an
 * agy update):
 *
 *   spawn : agy --print= --input-format stream-json --output-format stream-json
 *           [--add-dir W] [--conversation ID] [--dangerously-skip-permissions]
 *           [--model M] [--effort E] [--agent A] [--mode M] [--settings JSON]
 *   stdin : one NDJSON line per turn: {"event":"user","message":{"content":"..."}}
 *   stdout: NDJSON events; first {"event":"init","conversation_id":...},
 *           then step_update deltas, then {"event":"result","result":{...}}
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

/** A tiny async FIFO with an optional per-wait timeout. */
class EventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
  }

  push(item) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** Resolve with the next item, or `undefined` after `timeoutMs`. */
  next(timeoutMs) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      let timer = null;
      const waiter = (item) => {
        if (timer) clearTimeout(timer);
        resolve(item);
      };
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }
}

const AGENT_RESPONSE = "agent_response";

/** Concatenate agent_response text deltas from a turn's step_update events. */
export function agentText(events) {
  let out = "";
  for (const ev of events) {
    const su = ev?.step_update;
    if (su?.step_type === AGENT_RESPONSE && su.text_delta) out += su.text_delta;
  }
  return out;
}

/** Tool calls that completed during a turn. */
export function toolCalls(events) {
  const calls = [];
  for (const ev of events) {
    const su = ev?.step_update;
    if (su?.step_type === "tool" && su.state === "DONE") {
      calls.push({
        tool: su.tool_name,
        params: su.tool_info?.parameters ?? null,
      });
    }
  }
  return calls;
}

export class AgySession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.bin            agy executable
   * @param {string} [opts.workspace]    cwd + --add-dir
   * @param {string} [opts.conversation] agy conversation id to resume
   * @param {string[]} [opts.allow]      permission allow rules
   * @param {string[]} [opts.deny]       permission deny rules
   * @param {boolean} [opts.skipPermissions]
   * @param {string} [opts.model]
   * @param {string} [opts.effort]
   * @param {string} [opts.agent]
   * @param {string} [opts.mode]
   * @param {string} [opts.jsonSchema]
   * @param {string} [opts.toolPermission]
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.conversationId = opts.conversation || null;
    this.closed = false;
    this.exitCode = null;
    this._queue = new EventQueue();
    this._stderr = [];
    this._closing = null;

    const cmd = [
      opts.bin || "agy",
      "--print=",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ];
    if (opts.workspace) cmd.push("--add-dir", opts.workspace);
    if (opts.conversation) cmd.push("--conversation", opts.conversation);
    if (opts.skipPermissions) cmd.push("--dangerously-skip-permissions");
    if (opts.model) cmd.push("--model", opts.model);
    if (opts.effort) cmd.push("--effort", opts.effort);
    if (opts.agent) cmd.push("--agent", opts.agent);
    if (opts.mode) cmd.push("--mode", opts.mode);
    if (opts.jsonSchema) cmd.push("--json-schema", opts.jsonSchema);

    const settings = {};
    const perms = {};
    if (opts.allow?.length) perms.allow = [...opts.allow];
    if (opts.deny?.length) perms.deny = [...opts.deny];
    if (Object.keys(perms).length) settings.permissions = perms;
    if (opts.toolPermission) settings.toolPermission = opts.toolPermission;
    if (Object.keys(settings).length) cmd.push("--settings", JSON.stringify(settings));

    this.cmd = cmd;
    this.proc = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.workspace || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.on("error", (err) => {
      this.exitCode = -1;
      this.emit("error", err);
      this._queue.push({ event: "__exit__", error: err });
    });
    this.proc.on("exit", (code, signal) => {
      this.exitCode = code ?? -1;
      this.emit("exit", { code, signal });
      this._queue.push({ event: "__exit__", code, signal });
    });

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        return; // not protocol traffic; ignore
      }
      if (ev?.event === "init" && ev.conversation_id) {
        this.conversationId = ev.conversation_id;
      }
      this.emit("evt", ev);
      this._queue.push(ev);
    });

    createInterface({ input: this.proc.stderr }).on("line", (line) => {
      this._stderr.push(line);
      if (this._stderr.length > 500) this._stderr.shift();
    });
  }

  get pid() {
    return this.proc?.pid;
  }

  get alive() {
    return this.proc != null && this.exitCode === null;
  }

  stderrTail(n = 30) {
    return this._stderr.slice(-n).join("\n");
  }

  /**
   * Send one turn and resolve when the `result` event arrives.
   * @param {string} prompt
   * @param {number} [timeoutMs] 0/undefined = wait forever
   * @returns {Promise<object>} normalized result
   */
  ask(prompt, timeoutMs = 0) {
    if (this.closed) return Promise.reject(new Error("session is closed"));
    if (!this.alive) {
      return Promise.reject(
        new Error(`agy is not running:\n${this.stderrTail()}`),
      );
    }

    const payload = JSON.stringify({
      event: "user",
      message: { content: prompt },
    });

    return new Promise((resolve, reject) => {
      const events = [];
      const deadline = timeoutMs ? Date.now() + timeoutMs : 0;

      try {
        this.proc.stdin.write(payload + "\n");
      } catch (err) {
        reject(new Error(`could not write to agy: ${err.message}`));
        return;
      }

      const pump = async () => {
        try {
          for (;;) {
            let wait = 500;
            if (deadline) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                reject(
                  new Error(`turn exceeded ${Math.round(timeoutMs / 1000)}s`),
                );
                return;
              }
              wait = Math.min(wait, remaining);
            }

            const ev = await this._queue.next(wait);

            if (ev === undefined) {
              if (!this.alive) {
                reject(new Error(`agy exited:\n${this.stderrTail()}`));
                return;
              }
              continue;
            }
            if (ev.event === "__exit__") {
              reject(new Error(`agy exited:\n${this.stderrTail()}`));
              return;
            }
            if (ev.event === "error") {
              // agy can emit a terminal error event instead of result
              reject(
                new Error(
                  ev.message || ev.error || JSON.stringify(ev).slice(0, 500),
                ),
              );
              return;
            }

            events.push(ev);
            if (ev.event !== "result") continue;

            const r = ev.result || {};
            resolve({
              conversationId: r.conversation_id || this.conversationId,
              status: r.status,
              response: r.response || agentText(events),
              error: r.error ?? null,
              deniedActions: r.denied_actions || [],
              toolsUsed: toolCalls(events),
              durationSeconds: r.duration_seconds ?? null,
              numTurns: r.num_turns ?? null,
              usage: r.usage ?? null,
              structuredOutput: r.structured_output ?? null,
            });
            return;
          }
        } catch (err) {
          reject(err);
        }
      };

      pump();
    });
  }

  /** Graceful close: SIGTERM, then SIGKILL if agy does not go away. */
  close() {
    if (this._closing) return this._closing;
    this.closed = true;
    this._closing = new Promise((resolve) => {
      if (!this.proc || this.exitCode !== null) return resolve();
      try {
        this.proc.stdin?.end();
      } catch {
        /* noop */
      }
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* noop */
      }
      const timer = setTimeout(() => {
        try {
          // agy ignores SIGTERM when idle — make sure it is gone
          this.proc.kill("SIGKILL");
        } catch {
          /* noop */
        }
        resolve();
      }, 5000);
      timer.unref?.();
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this._closing;
  }

  /** Synchronous kill used from process `exit` handlers. */
  killNow() {
    this.closed = true;
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
}

export default AgySession;
