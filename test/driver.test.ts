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
  await qavo(["stop", "--name", "observe"]);
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

  test("a socket path over the Unix limit fails with a hint, not a crash", async () => {
    const longHome = join(home, "a".repeat(100));
    const failed = await qavo(["start", `${server.url}/form.html`, "--name", "long"], { QAVO_HOME: longHome });
    expect(failed).toMatchObject({ code: 1, json: { ok: false, error: { code: "path_too_long" } } });
    expect(failed.json.error!.hint).toContain("QAVO_HOME");
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
  await qavo(["stop", "--name", "observe"]);
    expect(existsSync(join(dir, "driver.sock"))).toBe(false);
  });
});

type Json = Record<string, unknown> & { ok: boolean; error?: { code: string; hint?: string } };
type NetworkEntry = { id: number; method: string; url: string; status?: number; failure?: string };

describe("qavo browser network, console, and eval", { timeout: 60_000 }, () => {
  const observe = async (args: string[], env: Record<string, string> = {}) => (await qavo(args, { QAVO_DRIVER: "observe", ...env })).json as Json;
  const clickNamed = async (name: string) => observe(["click", String(indexOf(await snapshot(), name))]);
  const snapshot = async () => (await observe(["snapshot"])) as unknown as Snapshot;

  beforeAll(async () => {
    expect((await observe(["start", `${server.url}/api.html`])).ok).toBe(true);
  });

  test("an action result counts its requests, and network shows the calls with status", async () => {
    await observe(["type", String(indexOf(await snapshot(), "Note")), "rush order"]);
    const saved = await clickNamed("Save");
    expect(saved).toMatchObject({ ok: true, network: { requests: 1, failed: [] }, console: { errors: 0 } });

    const network = await observe(["network", "--last-action"]);
    const calls = network.requests as NetworkEntry[];
    expect(calls).toEqual([expect.objectContaining({ method: "POST", url: `${server.url}/api/echo`, status: 200 })]);

    const detail = await observe(["network", String(calls[0]!.id)]);
    expect(detail).toMatchObject({ ok: true, request: { method: "POST", status: 200, requestBody: '{"note":"rush order"}' } });
    expect(String((detail.request as Record<string, unknown>).responseBody)).toContain("rush order");
    expect(JSON.stringify(detail)).not.toContain("header-token");
  });

  test("a failed call and a console error show in the action result", async () => {
    const broken = await clickNamed("Save to broken API");
    expect(broken).toMatchObject({
      ok: true,
      network: { failed: [expect.objectContaining({ method: "POST", url: `${server.url}/api/fail`, status: 500 })] },
      console: { errors: 1, messages: [expect.objectContaining({ level: "error", text: "Save failed: Database is down" })] },
    });
    expect((await observe(["network", "--failed"])).requests).toHaveLength(1);
  });

  test("an uncaught page error shows in the action result and in console", async () => {
    const crashed = await clickNamed("Crash");
    expect(crashed).toMatchObject({ console: { errors: 1, messages: [expect.objectContaining({ level: "pageerror", text: expect.stringContaining("Cannot read the order total") })] } });

    const errors = await observe(["console", "--level", "error"]);
    expect((errors.messages as { level: string }[]).map((m) => m.level)).toEqual(["error", "pageerror"]);
    const all = await observe(["console"]);
    expect(all.messages).toContainEqual(expect.objectContaining({ level: "log", text: "Orders page ready" }));
  });

  test("eval returns a JSON value and does not count as an action", async () => {
    expect(await observe(["eval", "document.title"])).toMatchObject({ ok: true, value: "Orders", pageChanged: false });
    expect(await observe(["eval", "[...document.querySelectorAll('button')].map((b) => b.textContent)"])).toMatchObject({
      value: ["Save", "Save to broken API", "Crash", "Log in", "Search and cancel"],
    });
    expect(await observe(["eval", "document.querySelector('h1')"])).toMatchObject({ value: "<h1>" });

    const bad = await observe(["eval", "let x = 1; x"]);
    expect(bad).toMatchObject({ ok: false, error: { code: "eval_failed" } });
    expect(bad.error!.hint).toContain("=>");
  });

  test("an eval that changes the page says so, and the next action must snapshot again", async () => {
    const state = await snapshot();
    const changed = await observe(["eval", "document.getElementById('note').value = 'set by eval'"]);
    expect(changed).toMatchObject({ ok: true, pageChanged: true });
    expect(String(changed.warning)).toContain("snapshot");
    const refused = await observe(["click", String(indexOf(state, "Save"))]);
    expect(refused).toMatchObject({ ok: false, error: { code: "refused", reason: "stale" } });
  });

  test("a secret typed from --env is hidden in network bodies and eval output", async () => {
    const env = { QAVO_TEST_PASSWORD: "pw-s3cret-42" };
    await observe(["type", String(indexOf(await snapshot(), "Password")), "--env", "QAVO_TEST_PASSWORD"], env);
    await clickNamed("Log in");
    const [login] = (await observe(["network", "--last-action"])).requests as NetworkEntry[];
    const detail = await observe(["network", String(login!.id)]);
    expect(JSON.stringify(detail)).toContain("***");
    expect(JSON.stringify(detail)).not.toContain("pw-s3cret-42");
    expect(await observe(["eval", "document.getElementById('pw').value"])).toMatchObject({ value: "***" });
  });

  test("a request that the app cancels is aborted, not failed", async () => {
    const canceled = await clickNamed("Search and cancel");
    expect(canceled).toMatchObject({ ok: true, network: { aborted: 1, failed: [] } });
    const [search] = (await observe(["network", "--last-action"])).requests as NetworkEntry[];
    expect(search).toMatchObject({ url: `${server.url}/slow/queue.json`, failure: "net::ERR_ABORTED" });
    expect((await observe(["network", "--failed", "--last-action"])).requests).toEqual([]);
  });

  test("a click reports the target's state after the action", async () => {
    await observe(["open", "/form.html"]);
    const clicked = await clickNamed("Send me the newsletter");
    expect(clicked).toMatchObject({ ok: true, target: { name: "Send me the newsletter", after: { checked: true } } });
  });

  test("hundreds of static requests do not push the app's requests out", async () => {
    await observe(["open", "/assets.html"]);
    await clickNamed("Load report");
    const urls = ((await observe(["network", "--limit", "1000"])).requests as NetworkEntry[]).map((entry) => entry.url);
    expect(urls).toContain(`${server.url}/api.html`);
    expect(urls).toContain(`${server.url}/assets.html`);
    expect(urls.filter((url) => url.includes("/asset/"))).toEqual([]);
    const all = (await observe(["network", "--all", "--limit", "1000"])).requests as NetworkEntry[];
    expect(all.filter((entry) => entry.url.includes("/asset/")).length).toBeGreaterThan(400);
  });

  test("a snapshot names the layer that covers the controls, and closing it counts as a change", async () => {
    await observe(["open", "/overlay.html"]);
    const covered = await snapshot();
    expect(covered.elements).toEqual([]);
    expect(covered.covered).toMatchObject({ count: 1, by: { tag: "error-overlay", text: "Build failed: missing export 'total' in invoice.ts" } });

    const closed = await observe(["press", "Escape"]);
    expect(closed).toMatchObject({ ok: true, pageChanged: true, elements: 1 });
    expect(closed.covered).toBeUndefined();
  });

  test("network with an unknown id says how to list the ids", async () => {
    const missing = await observe(["network", "99999"]);
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(missing.error!.hint).toContain("qavo browser network");
  });
});
