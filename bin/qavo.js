#!/usr/bin/env node
import { register } from "tsx/esm/api";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) {
  const message = `qavo needs Node 24 or later. This is Node ${process.versions.node}.`;
  const error = { code: "node_version", message, hint: "Install Node 24 or later, for example with `nvm install 24`." };
  console.log(process.argv[2] === "browser" ? JSON.stringify({ ok: false, error }) : message);
  process.exit(1);
}

register();
// `qavo browser` skips the imports of the Jev runner, so that each agent command starts fast.
await import(process.argv[2] === "browser" ? "../src/driver/main.ts" : "../src/cli.ts");
