#!/usr/bin/env node
import { main } from "../src/server.js";

main().catch((err) => {
  console.error("[agy-mcp] fatal:", err);
  process.exit(1);
});
