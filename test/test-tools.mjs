#!/usr/bin/env node
/**
 * Tool-surface test: drives the MCP server through a real in-memory MCP
 * client session and calls every tool that does not require a live agent.
 *
 * Set AGY_TEST_LIVE=1 to also run a real turn through agy_ask / agy_stop.
 *
 * Usage: npm test
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const live = process.env.AGY_TEST_LIVE === "1";

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failed = true;
};

const { server, manager } = createServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);

const client = new Client({ name: "agy-mcp-test", version: "1.0.0" });
await client.connect(clientTransport);

try {
  // --- tool discovery ------------------------------------------------------
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "agy_ask",
    "agy_ask_new",
    "agy_conversations",
    "agy_models",
    "agy_resume",
    "agy_status",
    "agy_stop",
  ];
  check("tools/list", JSON.stringify(names) === JSON.stringify(expected), names.join(","));

  for (const tool of tools) {
    check(`schema: ${tool.name}`, Boolean(tool.inputSchema), JSON.stringify(tool.inputSchema).slice(0, 60));
  }

  // --- agy_status ----------------------------------------------------------
  const status = await client.callTool({ name: "agy_status", arguments: {} });
  const statusText = status.content?.[0]?.text || "";
  check("agy_status returns text", statusText.includes("agy version"), statusText.split("\n")[0]);

  // --- agy_models ----------------------------------------------------------
  const models = await client.callTool({ name: "agy_models", arguments: {} });
  const modelsText = models.content?.[0]?.text || "";
  check(
    "agy_models returns a list or a login hint",
    modelsText.split("\n").filter(Boolean).length > 0,
    modelsText.split("\n")[0],
  );

  // --- agy_conversations ---------------------------------------------------
  const convs = await client.callTool({ name: "agy_conversations", arguments: {} });
  const convsText = convs.content?.[0]?.text || "";
  let parsed = null;
  try {
    parsed = JSON.parse(convsText);
  } catch {
    /* handled below */
  }
  check("agy_conversations returns JSON", Array.isArray(parsed), convsText.slice(0, 80));

  // --- agy_stop on an unknown conversation ---------------------------------
  const stop = await client.callTool({
    name: "agy_stop",
    arguments: { conversation_id: "does-not-exist" },
  });
  check("agy_stop handles unknown id", Boolean(stop.content?.[0]?.text));

  // --- live turn (opt-in) --------------------------------------------------
  if (live) {
    const ask = await client.callTool({
      name: "agy_ask",
      arguments: { question: "Reply with exactly MCP_OK and nothing else.", timeout: 180 },
    });
    const askText = ask.content?.[0]?.text || "";
    check("agy_ask live turn", askText.includes("MCP_OK"), askText.slice(0, 120));
    check("agy_ask reports conversation", askText.includes("conversation_id="));

    const convs2 = await client.callTool({ name: "agy_conversations", arguments: {} });
    const list2 = JSON.parse(convs2.content?.[0]?.text || "[]");
    check("conversation is registered", list2.length >= 1, JSON.stringify(list2[0] || {}));

    const stop2 = await client.callTool({
      name: "agy_stop",
      arguments: { conversation_id: "default" },
    });
    check("agy_stop stops the conversation", (stop2.content?.[0]?.text || "").startsWith("stopped"));
  } else {
    console.log("SKIP agy_ask live turn (set AGY_TEST_LIVE=1 to enable)");
  }
} catch (err) {
  failed = true;
  console.error("FAIL harness:", err.stack || err);
} finally {
  await client.close();
  await manager.closeAll();
  await server.close();
}

if (failed) {
  console.error("\ntool tests FAILED");
  process.exit(1);
}
console.log("\ntool tests PASSED");
