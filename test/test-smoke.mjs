#!/usr/bin/env node
/**
 * Live smoke test: start one agy session and verify a real turn.
 *
 * Requires an installed + logged-in agy (see `agyq doctor`).
 * Usage: npm run test:smoke
 */
import { AgySession } from "../src/agy-session.js";
import { config } from "../src/config.js";

const session = new AgySession({
  bin: config.bin,
  workspace: config.workspace,
  allow: config.allow,
  deny: config.deny,
  skipPermissions: config.skipPermissions,
  model: config.model || undefined,
  effort: config.effort || undefined,
});

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`FAIL: ${msg}`);
};

try {
  console.log(`agy binary: ${config.bin}`);
  console.log(`workspace : ${config.workspace}`);
  console.log("asking: Reply with exactly SMOKE_OK and nothing else");

  const res = await session.ask("Reply with exactly SMOKE_OK and nothing else.", 180_000);

  console.log(`status          : ${res.status}`);
  console.log(`conversation_id : ${res.conversationId}`);
  console.log(`duration        : ${res.durationSeconds}s`);
  console.log(`response        : ${JSON.stringify(res.response)}`);

  if (res.status !== "SUCCESS") fail(`status is ${res.status}: ${res.error}`);
  if (!res.response?.includes("SMOKE_OK")) fail("response does not contain SMOKE_OK");
  if (!res.conversationId) fail("no conversation_id returned");
  if (!res.usage) fail("no usage returned");
} catch (err) {
  fail(err.stack || err.message);
} finally {
  await session.close();
}

if (failed) {
  console.error("\nsmoke test FAILED");
  process.exit(1);
}
console.log("\nsmoke test PASSED");
