#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
// `qavo browser` skips the imports of the Jev runner, so that each agent command starts fast.
await import(process.argv[2] === "browser" ? "../src/driver/main.ts" : "../src/cli.ts");
