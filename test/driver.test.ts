import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Snapshot } from "../src/browser/snapshot.ts";
import { serveFixtures } from "./serve.ts";

const BIN = new URL("../bin/qavo.js", import.meta.url).pathname;
let home: string;
let server: Awaited<ReturnType<typeof serveFixtures>>;

/** Runs `qavo browser <args>` through the real binary and parses its one JSON line. */
async function qavo(args: string[], env: Record<string, string> = {}) {
  const { stdout, code } = await promisify(execFile)(process.execPath, [BIN, "browser", ...args], {
    env: { ...process.env, QAVO_HOME: home, ...env },
  }).then(({ stdout }) => ({ stdout, code: 0 }), (error: { stdout: string; code: number }) => ({ stdout: error.stdout, code: error.code }));
  return { code, json: JSON.parse(stdout) as { ok: boolean; error?: { code: string; reason?: string; hint?: string }; [key: string]: unknown } };
}

const snapshot = async () => (await qavo(["snapshot"])).json as unknown as Snapshot & { ok: true };
const indexOf = (state: Snapshot, name: string) => state.elements.find((e) => e.name === name)!.index;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "qavo-driver-"));
  server = await serveFixtures();
});

afterAll(async () => {
  await qavo(["stop"]);
  await qavo(["stop", "--name", "crash"]);
  await server?.close();
  await rm(home, { recursive: true, force: true });
});

describe("qavo browser", { timeout: 60_000 }, () => {
  test("start opens the app, and snapshot waits past the skeleton for the data", async () => {
    const started = await qavo(["start", `${server.url}/spa.html`]);
    expect(started).toMatchObject({ code: 0, json: { ok: true, name: "default", allowHosts: [new URL(server.url).host] } });

    const state = await snapshot();
    expect(state.text).toContain("2 left");
    expect(state.elements.map((e) => e.name)).toEqual(["DS", "Owed at takeover", "Save and next"]);

    const again = await qavo(["start", `${server.url}/spa.html`]);
    expect(again).toMatchObject({ code: 1, json: { ok: false, error: { code: "already_running" } } });
  });

  test("type and click act by index and report what changed; the output never echoes typed text", async () => {
    const state = await snapshot();
    const typed = await qavo(["type", String(indexOf(state, "Owed at takeover")), "125.50"]);
    expect(typed.json).toMatchObject({ ok: true, target: { name: "Owed at takeover" }, typed: { characters: 6 } });
    expect(JSON.stringify(typed.json)).not.toContain("125.50");

    const clicked = await qavo(["click", String(indexOf(state, "Save and next"))]);
    expect(clicked.json).toMatchObject({ ok: true, pageChanged: true, changes: { removed: ["2 left", "112 Automotive Blvd"], added: ["1 left", "21 Aberdeen Ave"] } });
  });

  test("an action with an old fingerprint is refused with a hint, and the page gets no input", async () => {
    const old = await snapshot();
    await qavo(["type", String(indexOf(old, "Owed at takeover")), "9"]);
    const refused = await qavo(["click", String(indexOf(old, "Save and next")), "--fp", old.fingerprint]);
    expect(refused).toMatchObject({ code: 1, json: { ok: false, error: { code: "refused", reason: "stale" } } });
    expect(refused.json.error!.hint).toContain("qavo browser snapshot");
    expect((await snapshot()).text).toContain("1 left");
  });

  test("--dry-run runs the guards and names the target without clicking", async () => {
    const state = await snapshot();
    const dry = await qavo(["click", String(indexOf(state, "Save and next")), "--dry-run"]);
    expect(dry.json).toMatchObject({ ok: true, dryRun: true, target: { role: "button", name: "Save and next" } });
    expect((await snapshot()).text).toContain("1 left");
  });

  test("a password field takes text only from --env, and the secret is never printed", async () => {
    await qavo(["open", "/form.html"]);
    const password = indexOf(await snapshot(), "Password");
    const literal = await qavo(["type", String(password), "hunter2"]);
    expect(literal.json).toMatchObject({ ok: false, error: { code: "secret_literal" } });
    expect(literal.json.error!.hint).toContain("--env");

    const fromEnv = await qavo(["type", String(password), "--env", "QAVO_TEST_SECRET"], { QAVO_TEST_SECRET: "s3cret-value" });
    expect(fromEnv.json).toMatchObject({ ok: true, target: { sensitive: true }, typed: { env: "QAVO_TEST_SECRET" } });
    expect(JSON.stringify(fromEnv.json)).not.toContain("s3cret-value");
    expect(JSON.stringify(await snapshot())).not.toContain("s3cret-value");
  });

  test("open refuses a host outside allowHosts", async () => {
    const refused = await qavo(["open", "https://example.com/"]);
    expect(refused.json).toMatchObject({ ok: false, error: { code: "host_not_allowed" } });
  });

  test("screenshot writes a PNG and returns its path", async () => {
    const shot = await qavo(["screenshot"]);
    expect(shot.json.ok).toBe(true);
    const bytes = await readFile(shot.json.path as string);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  });

  test("usage errors are JSON with a hint", async () => {
    expect((await qavo(["frobnicate"])).json).toMatchObject({ ok: false, error: { code: "unknown_command" } });
    expect((await qavo(["click", "abc"])).json).toMatchObject({ ok: false, error: { code: "usage" } });
    expect((await qavo(["status", "--name", "../x"])).json).toMatchObject({ ok: false, error: { code: "bad_name" } });
  });

  test("stop closes the driver; commands then say how to start one", async () => {
    expect((await qavo(["stop"])).json).toMatchObject({ ok: true, stopped: { name: "default" } });
    const status = await qavo(["status"]);
    expect(status.json).toMatchObject({ ok: false, error: { code: "not_running" } });
    expect(status.json.error!.hint).toContain("qavo browser start");
  });

  test("start reports why the app did not open", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const failed = await qavo(["start", `http://127.0.0.1:${port}/`, "--name", "down"]);
    expect(failed).toMatchObject({ code: 1, json: { ok: false, error: { code: "start_failed" } } });
    expect(failed.json.error).toMatchObject({ message: expect.stringContaining("ERR_CONNECTION_REFUSED") });
  });

  test("stop cleans up a driver that was killed", async () => {
    await qavo(["start", `${server.url}/form.html`, "--name", "crash"]);
    const dir = join(home, "drivers", "crash");
    const { pid } = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { pid: number };
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const doctor = await qavo(["doctor", "--name", "crash"]);
    expect(doctor.json.checks).toContainEqual(expect.objectContaining({ name: "driver", ok: false }));
    expect((await qavo(["stop", "--name", "crash", "--dry-run"])).json).toMatchObject({ ok: true, dryRun: true, wouldRemove: [join(dir, "driver.sock"), join(dir, "state.json")] });
    expect(existsSync(join(dir, "driver.sock"))).toBe(true);
    await qavo(["stop", "--name", "crash"]);
    expect(existsSync(join(dir, "driver.sock"))).toBe(false);
  });
});
