import { existsSync } from "node:fs";
import { browserCommand } from "./commands.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
process.exitCode = await browserCommand(process.argv.slice(3));
