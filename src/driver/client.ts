import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { DriverError, type DriverOptions, type DriverPaths, type Request } from "./protocol.ts";

type Reply = { ok: true; [key: string]: unknown } | { ok: false; error: { code: string; message: string; hint?: string } };

const START_TIMEOUT_MS = 30_000;
const BIN = fileURLToPath(new URL("../../bin/qavo.js", import.meta.url));
/** Marks the driver log line that holds a start error as JSON. */
export const START_ERROR = "qavo-start-error: ";
/** The environment variable that carries DriverOptions to the driver process. */
export const OPTIONS_ENV = "QAVO_DRIVER_OPTIONS";

const notRunning = (paths: DriverPaths) =>
  new DriverError("not_running", `No driver named "${paths.name}" is running.`, `Run \`qavo browser start <url>${paths.name === "default" ? "" : ` --name ${paths.name}`}\` first.`);

/** Sends one command to the driver. Throws not_running when nothing answers on the socket. */
export function call(paths: DriverPaths, command: Request | Record<string, unknown>, timeoutMs = 120_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    if (!existsSync(paths.socket)) return reject(notRunning(paths));
    const req = httpRequest({ socketPath: paths.socket, method: "POST", path: "/", timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Reply);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new DriverError("timeout", `The driver did not answer in ${timeoutMs / 1000} s.`, "Run `qavo browser doctor`. Run `qavo browser stop`, then start again, if it stays stuck.")));
    req.on("error", (error: NodeJS.ErrnoException) => {
      reject(error instanceof DriverError ? error : ["ECONNREFUSED", "ENOENT"].includes(error.code ?? "") ? notRunning(paths) : error);
    });
    req.end(JSON.stringify(command));
  });
}

async function readState(paths: DriverPaths): Promise<{ pid: number } | undefined> {
  try {
    return JSON.parse(await readFile(paths.state, "utf8"));
  } catch {
    return undefined;
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Removes the socket and state file of a driver that is no longer running. */
async function removeStale(paths: DriverPaths) {
  await rm(paths.socket, { force: true });
  await rm(paths.state, { force: true });
}

/** Spawns the driver process and waits until it answers `status`. */
export async function startDriver(paths: DriverPaths, options: DriverOptions) {
  const running = await call(paths, { command: "status" }).catch(() => undefined);
  if (running?.ok) {
    throw new DriverError("already_running", `A driver named "${paths.name}" is already running at ${String(running.url)}.`,
      `Use it, run \`qavo browser stop${paths.name === "default" ? "" : ` --name ${paths.name}`}\` first, or start another with --name.`);
  }
  await removeStale(paths);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const log = openSync(paths.log, "w", 0o600);
  const child = spawn(process.execPath, [BIN, "browser", "serve", "--name", paths.name], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, [OPTIONS_ENV]: JSON.stringify(options) },
  });
  closeSync(log);
  let exited: number | null | undefined;
  child.on("exit", (code) => (exited = code));
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      const lines = (await readFile(paths.log, "utf8").catch(() => "")).trim().split("\n");
      const reported = lines.findLast((line) => line.startsWith(START_ERROR));
      if (reported) {
        const { code, message, hint } = JSON.parse(reported.slice(START_ERROR.length)) as { code: string; message: string; hint?: string };
        throw new DriverError(code, message, hint);
      }
      throw new DriverError("start_failed", `The driver exited with code ${exited}. Log tail:\n${lines.slice(-8).join("\n")}`,
        "Run `qavo browser doctor` to check Node and Chromium.");
    }
    const reply = await call(paths, { command: "status" }, 2_000).catch(() => undefined);
    if (reply?.ok) return reply;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new DriverError("start_failed", `The driver did not answer within ${START_TIMEOUT_MS / 1000} s.`, `Read the log: ${paths.log}`);
}

/** Stops the driver. When it does not answer, ends its process and removes its files. */
export async function stopDriver(paths: DriverPaths, dryRun: boolean) {
  const status = await call(paths, { command: "status" }, 5_000).catch(() => undefined);
  const state = await readState(paths);
  const pid = status?.ok ? Number(status.pid) : state?.pid;
  const alive = pid !== undefined && isAlive(pid);
  if (dryRun) {
    return { dryRun: true, name: paths.name, wouldStop: alive ? { pid, ...(status?.ok && { url: status.url }) } : null, wouldRemove: [paths.socket, paths.state].filter(existsSync) };
  }
  if (status?.ok) {
    await call(paths, { command: "stop" }, 5_000).catch(() => undefined);
  } else if (alive) {
    process.kill(pid, "SIGTERM");
  }
  for (let i = 0; i < 50 && pid !== undefined && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  await removeStale(paths);
  return { stopped: alive ? { name: paths.name, pid } : null };
}

type Check = { name: string; ok: boolean; detail: string; fix?: string };

/** Reports what could stop the driver from working, with a fix for each failed check. */
export async function doctor(paths: DriverPaths) {
  const checks: Check[] = [];
  const [major] = process.versions.node.split(".").map(Number);
  checks.push({ name: "node", ok: major! >= 24, detail: process.versions.node, ...(major! < 24 && { fix: "Install Node 24 or later." }) });
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch();
    checks.push({ name: "chromium", ok: true, detail: `Launched ${browser.version()} headless.` });
    await browser.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    checks.push({ name: "chromium", ok: false, detail, fix: "Run `pnpm exec playwright-core install chromium`." });
  }

  const status = await call(paths, { command: "status" }, 5_000).catch(() => undefined);
  if (status?.ok) {
    checks.push({ name: "driver", ok: true, detail: `"${paths.name}" is running (pid ${String(status.pid)}) at ${String(status.url)}.` });
    return { healthy: checks.every((check) => check.ok), checks, driver: status };
  }
  const state = await readState(paths);
  if (state && isAlive(state.pid)) {
    checks.push({ name: "driver", ok: false, detail: `Process ${state.pid} is alive but does not answer on ${paths.socket}.`, fix: `Run \`qavo browser stop --name ${paths.name}\`, then start again.` });
  } else if (existsSync(paths.socket) || state) {
    checks.push({ name: "driver", ok: false, detail: "A stopped driver left its files behind.", fix: `Run \`qavo browser stop --name ${paths.name}\` to remove them.` });
  } else {
    checks.push({ name: "driver", ok: true, detail: `No driver named "${paths.name}" is running. \`qavo browser start <url>\` starts one.` });
  }
  return { healthy: checks.every((check) => check.ok), checks, log: existsSync(paths.log) ? paths.log : null };
}
