import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Config } from "./scenario.ts";

const CONFIG_NAMES = ["qavo.config.ts", "qavo.config.js"];

/** Finds qavo.config.ts in the folder or a parent folder. */
function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const found = CONFIG_NAMES.map((name) => join(dir, name)).find(existsSync);
    if (found) return found;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Loads `configOption`, or the nearest qavo.config.ts above `searchFrom`. Relative config paths resolve against `baseDir`. */
export async function loadConfig(configOption: string | undefined, searchFrom: string) {
  const configPath = configOption ? resolve(configOption) : findConfig(searchFrom);
  const config = Config.parse(configPath ? (await import(pathToFileURL(configPath).href)).default : {});
  return { config, baseDir: configPath ? dirname(configPath) : process.cwd() };
}

export function resolveSessionPath(path: string, baseDir = process.cwd()) {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(baseDir, path);
}

/** The storage state from `--storage-state`, else from config. Throws with the login command when the file is missing. */
export function storageStatePath(option: string | undefined, config: Config, baseDir: string) {
  const path = option !== undefined
    ? resolveSessionPath(option)
    : config.storageState !== undefined ? resolveSessionPath(config.storageState, baseDir) : undefined;
  if (path && !existsSync(path)) {
    throw new Error(`The storage state ${path} does not exist. Run: qavo login <url> --out ${path}`);
  }
  return path;
}
