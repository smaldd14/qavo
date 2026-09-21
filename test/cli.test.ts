import { constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunReport, Status } from "../src/report.ts";
import { Config, Scenario } from "../src/scenario.ts";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<typeof import("node:fs").existsSync>(() => false),
  readFile: vi.fn<() => Promise<string>>(),
  loadEnvFile: vi.fn(),
  TypeSafeClient: vi.fn(function () {}),
  createRunDir: vi.fn<typeof import("../src/report.ts").createRunDir>(),
  writeReport: vi.fn<typeof import("../src/report.ts").writeReport>(),
  runScenario: vi.fn<typeof import("../src/run.ts").runScenario>(),
  uploadRunArtifacts: vi.fn<typeof import("../src/upload.ts").uploadRunArtifacts>(),
  textModelFromEnv: vi.fn<typeof import("../src/values.ts").textModelFromEnv>(),
  blockOtherHosts: vi.fn<() => Promise<void>>(),
  launch: vi.fn(),
  newContext: vi.fn(),
  newPage: vi.fn(),
  close: vi.fn<() => Promise<void>>(),
  homedir: vi.fn(() => "/virtual-home"),
  mkdir: vi.fn(),
  chmod: vi.fn(),
  open: vi.fn(),
  fileChmod: vi.fn(),
  fileWrite: vi.fn(),
  fileClose: vi.fn(),
  storageState: vi.fn(),
  goto: vi.fn(),
  question: vi.fn(),
  terminalClose: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.existsSync,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: mocks.readFile,
  mkdir: mocks.mkdir,
  chmod: mocks.chmod,
  open: mocks.open,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: mocks.homedir,
}));
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.terminalClose })),
}));
vi.mock("@typesafe-ai/sdk", () => ({ TypeSafeClient: mocks.TypeSafeClient }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../src/browser/act.ts", () => ({ blockOtherHosts: mocks.blockOtherHosts }));
vi.mock("../src/report.ts", () => ({ createRunDir: mocks.createRunDir, writeReport: mocks.writeReport }));
vi.mock("../src/run.ts", () => ({ runScenario: mocks.runScenario }));
vi.mock("../src/values.ts", () => ({ textModelFromEnv: mocks.textModelFromEnv }));
vi.mock("../src/upload.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/upload.ts")>(),
  uploadRunArtifacts: mocks.uploadRunArtifacts,
}));

const scenario = { name: "CLI fixture", url: "https://example.test/", steps: [{ intent: "Finish" }] };
const id = "00000000-0000-4000-8000-000000000001";
const dir = resolve("virtual-cli-output", "runs", id);
const reportPath = join(dir, "report.json");
const location = `s3://private-artifacts/qa/${id}/report.json`;
const uploadEnv = {
  QAVO_S3_ENDPOINT: "https://s3.example.test",
  QAVO_S3_BUCKET: "private-artifacts",
  QAVO_S3_PREFIX: "qa/",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
};
const uploadConfig = {
  endpoint: uploadEnv.QAVO_S3_ENDPOINT,
  bucket: uploadEnv.QAVO_S3_BUCKET,
  prefix: "qa",
  region: "auto",
};
const statuses: Status[] = ["pass", "fail", "blocked", "unclear"];
const localReports = new Map<string, string>();
const page = { goto: mocks.goto };
const home = "/virtual-home";
let configPath: string;
const session = { cookies: [], origins: [{ origin: scenario.url, localStorage: [{ name: "token", value: "private-session-token" }] }] };
let report: RunReport;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  configPath = join(await mkdtemp(join(tmpdir(), "qavo-cli-")), "qavo.config.mjs");
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  originalEnv = process.env;
  process.argv = [process.execPath, resolve("src/cli.ts"), "run", "scenario.json"];
  process.exitCode = undefined;
  process.env = {};
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "loadEnvFile").mockImplementation(mocks.loadEnvFile);
  localReports.clear();
  report = {
    id,
    scenario: scenario.name,
    url: scenario.url,
    status: "pass",
    startedAt: "2026-09-20T00:00:00.000Z",
    durationMs: 12,
    usage: { jevRequests: 1, jevInputTokens: 1, jevOutputTokens: 1, textModelCalls: 0, textModelInputTokens: 0, textModelOutputTokens: 0 },
    steps: [{ intent: "Finish", status: "pass", durationMs: 12, turns: [] }],
  };
  mocks.existsSync.mockReturnValue(false);
  mocks.readFile.mockResolvedValue(JSON.stringify(scenario));
  mocks.createRunDir.mockResolvedValue({ id, dir });
  mocks.launch.mockResolvedValue({ newContext: mocks.newContext, close: mocks.close });
  mocks.homedir.mockReturnValue(home);
  mocks.storageState.mockResolvedValue(session);
  mocks.open.mockResolvedValue({ chmod: mocks.fileChmod, writeFile: mocks.fileWrite, close: mocks.fileClose });
  mocks.newContext.mockResolvedValue({ newPage: mocks.newPage, storageState: mocks.storageState });
  mocks.newPage.mockResolvedValue(page);
  mocks.close.mockResolvedValue(undefined);
  mocks.blockOtherHosts.mockResolvedValue(undefined);
  mocks.textModelFromEnv.mockReturnValue(undefined);
  mocks.runScenario.mockResolvedValue(report);
  mocks.writeReport.mockImplementation(async (directory, result) => {
    const path = join(directory, "report.json");
    localReports.set(path, JSON.stringify(result));
    return path;
  });
  mocks.uploadRunArtifacts.mockResolvedValue(location);
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  process.env = originalEnv;
  vi.restoreAllMocks();
  await rm(dirname(configPath), { recursive: true, force: true });
});

describe("CLI run", () => {
  test("uses the default run directory without a repository root or local configuration", async () => {
    await import("../src/cli.ts");

    expect(mocks.createRunDir).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(mocks.existsSync).toHaveBeenCalledWith(".env");
    expect(mocks.loadEnvFile).not.toHaveBeenCalled();
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("scenario.json", "utf8");
    expect(mocks.TypeSafeClient).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith({ headless: true });
    expect(mocks.newContext).toHaveBeenCalledExactlyOnceWith({ viewport: { width: 1280, height: 800 }, storageState: undefined });
    expect(mocks.blockOtherHosts).toHaveBeenCalledExactlyOnceWith(page, ["example.test"]);
    expect(mocks.runScenario).toHaveBeenCalledExactlyOnceWith({
      page,
      jev: mocks.TypeSafeClient.mock.instances[0],
      textModel: undefined,
      scenario: Scenario.parse(scenario),
      url: scenario.url,
      allowHosts: ["example.test"],
      limits: Config.parse({}).limits,
      id: report.id,
      dir,
    });
    expect(mocks.writeReport).toHaveBeenCalledExactlyOnceWith(dir, report);
    expect(mocks.uploadRunArtifacts).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(`Report: ${reportPath}`);
    expect(process.exitCode).toBe(0);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith();
  });

  test("does not load a saved host session automatically", async () => {
    const saved = join(home, ".qavo/sessions/example.test.json");
    mocks.existsSync.mockImplementation((path) => path === saved);

    await import("../src/cli.ts");

    expect(mocks.existsSync).not.toHaveBeenCalledWith(saved);
    expect(mocks.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: undefined }));
  });

  test.each([
    { input: "./sessions/role.json", expected: resolve("sessions/role.json") },
    { input: "~/.qavo/sessions/role.json", expected: join(home, ".qavo/sessions/role.json") },
    { input: "/saved/role.json", expected: "/saved/role.json" },
  ])("resolves CLI --storage-state $input against the working directory or home", async ({ input, expected }) => {
    process.argv.push("--storage-state", input, "--config", configPath);
    await writeFile(configPath, 'export default { storageState: "unused.json" };');
    mocks.existsSync.mockImplementation((path) => path === expected);

    await import("../src/cli.ts");

    expect(mocks.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: expected }));
  });

  test.each([
    "./sessions/role.json",
    "~/.qavo/sessions/role.json",
    "/saved/role.json",
  ])("resolves config storageState %s against the config directory or home", async (input) => {
    const expected = input.startsWith("~/") ? join(home, input.slice(2)) : resolve(dirname(configPath), input);
    process.argv.push("--config", configPath);
    await writeFile(configPath, `export default ${JSON.stringify({ storageState: input })};`);
    mocks.existsSync.mockImplementation((path) => path === expected);

    await import("../src/cli.ts");

    expect(mocks.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: expected }));
  });

  test("rejects a missing explicit session before browser launch", async () => {
    process.argv.push("--storage-state", "~/missing.json");

    await expect(import("../src/cli.ts")).rejects.toThrow(join(home, "missing.json"));

    expect(mocks.launch).not.toHaveBeenCalled();
  });

  test("rejects a missing environment variable before browser launch", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ ...scenario, steps: [{ intent: "Log in", data: { password: "@env:QAVO_TEST_PASSWORD" } }] }));

    await expect(import("../src/cli.ts")).rejects.toThrow(/QAVO_TEST_PASSWORD/);

    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.TypeSafeClient).not.toHaveBeenCalled();
    expect(mocks.createRunDir).not.toHaveBeenCalled();
    expect(mocks.runScenario).not.toHaveBeenCalled();
  });

  test("validates environment references but passes the original scenario to the runner", async () => {
    process.env.QAVO_TEST_PASSWORD = "private-env-password";
    const referenced = { ...scenario, steps: [{ intent: "Log in", data: { password: "@env:QAVO_TEST_PASSWORD", literal: "plain text" } }] };
    mocks.readFile.mockResolvedValue(JSON.stringify(referenced));

    await import("../src/cli.ts");

    expect(mocks.runScenario).toHaveBeenCalledWith(expect.objectContaining({ scenario: Scenario.parse(referenced) }));
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(process.env.QAVO_TEST_PASSWORD);
  });

  test("rejects an invalid whole environment reference name before browser launch", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ ...scenario, steps: [{ intent: "Log in", data: { password: "@env:INVALID-NAME" } }] }));

    await expect(import("../src/cli.ts")).rejects.toThrow();

    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.runScenario).not.toHaveBeenCalled();
  });

  test("resolves an explicit --out root", async () => {
    process.argv.push("--out", "./custom-output/../artifacts");

    await import("../src/cli.ts");

    expect(mocks.createRunDir).toHaveBeenCalledExactlyOnceWith(resolve("artifacts"));
    expect(mocks.writeReport).toHaveBeenCalledExactlyOnceWith(dir, report);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith();
  });

  test.each([
    { env: { QAVO_S3_BUCKET: "private-artifacts" }, error: "Upload requires QAVO_S3_ENDPOINT and QAVO_S3_BUCKET." },
    { env: { QAVO_S3_ENDPOINT: uploadEnv.QAVO_S3_ENDPOINT, QAVO_S3_BUCKET: uploadEnv.QAVO_S3_BUCKET }, error: "Upload requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY." },
  ])("rejects invalid upload configuration before browser launch: $error", async ({ env, error }) => {
    Object.assign(process.env, env);

    await expect(import("../src/cli.ts")).rejects.toThrow(error);

    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.TypeSafeClient).not.toHaveBeenCalled();
    expect(mocks.createRunDir).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.runScenario).not.toHaveBeenCalled();
    expect(mocks.uploadRunArtifacts).not.toHaveBeenCalled();
    expect(mocks.loadEnvFile).not.toHaveBeenCalled();
  });

  test.each(statuses)("prints the upload location and retains the %s exit code", async (status) => {
    Object.assign(process.env, uploadEnv);
    report.status = status;
    report.steps[0]!.status = status;
    mocks.uploadRunArtifacts.mockImplementation(async () => {
      expect(localReports.get(reportPath)).toBe(JSON.stringify(report));
      expect(process.exitCode).toBe(status === "pass" ? 0 : 1);
      return location;
    });

    await import("../src/cli.ts");

    expect(mocks.uploadRunArtifacts).toHaveBeenCalledExactlyOnceWith(dir, report, uploadConfig);
    expect(console.log).toHaveBeenCalledWith(`Artifacts: ${location}`);
    expect(console.log).toHaveBeenCalledWith(`${status.toUpperCase()} ${scenario.name} in 12 ms, 1 Jev requests`);
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(status === "pass" ? 0 : 1);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith();
  });

  test.each(statuses)("sets exit code 2 on upload failure without changing the %s result or local report", async (status) => {
    Object.assign(process.env, uploadEnv);
    report.status = status;
    report.steps[0]!.status = status;
    const originalReport = structuredClone(report);
    mocks.uploadRunArtifacts.mockRejectedValue(new Error("Private provider response with test-secret-key"));

    await import("../src/cli.ts");

    expect(process.exitCode).toBe(2);
    expect(report).toEqual(originalReport);
    expect(mocks.writeReport).toHaveBeenCalledExactlyOnceWith(dir, originalReport);
    expect(localReports.get(reportPath)).toBe(JSON.stringify(originalReport));
    expect(mocks.uploadRunArtifacts).toHaveBeenCalledExactlyOnceWith(dir, originalReport, uploadConfig);
    expect(console.log).toHaveBeenCalledWith(`${status.toUpperCase()} ${scenario.name} in 12 ms, 1 Jev requests`);
    expect(console.log).toHaveBeenCalledWith(`Report: ${reportPath}`);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Artifacts:"));
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`Artifact upload failed. Local report: ${reportPath}`);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith();
  });

  test.each(["newContext", "runScenario", "writeReport"] as const)("closes the browser when %s fails", async (operation) => {
    const error = new Error(`${operation} failed`);
    mocks[operation].mockRejectedValue(error);

    await expect(import("../src/cli.ts")).rejects.toThrow(error);

    expect(mocks.close).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.uploadRunArtifacts).not.toHaveBeenCalled();
  });
});

describe("CLI login", () => {
  test.each([
    { url: "https://example.test/login", filename: "example.test.json" },
    { url: "http://localhost:3000/login", filename: "localhost%3A3000.json" },
    { url: "http://[::1]:3000/login", filename: "%5B%3A%3A1%5D%3A3000.json" },
  ])("saves $url to a private default session file", async ({ url, filename }) => {
    process.argv = [process.execPath, resolve("src/cli.ts"), "login", url];
    const out = join(home, ".qavo/sessions", filename);

    await import("../src/cli.ts");

    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith({ headless: false });
    expect(mocks.goto).toHaveBeenCalledExactlyOnceWith(url);
    expect(mocks.question).toHaveBeenCalledOnce();
    expect(mocks.terminalClose).toHaveBeenCalledOnce();
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(dirname(out), { recursive: true, mode: 0o700 });
    expect(mocks.chmod).toHaveBeenCalledExactlyOnceWith(dirname(out), 0o700);
    expect(mocks.storageState).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(out, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    expect(mocks.fileChmod).toHaveBeenCalledExactlyOnceWith(0o600);
    expect(mocks.fileWrite).toHaveBeenCalledExactlyOnceWith(JSON.stringify(session), "utf8");
    expect(mocks.fileChmod.mock.invocationCallOrder[0]).toBeLessThan(mocks.fileWrite.mock.invocationCallOrder[0]!);
    expect(mocks.fileClose).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(`Saved ${out}. Do not commit this file.`);
    expect(mocks.runScenario).not.toHaveBeenCalled();
  });

  test.each([
    { input: "./sessions/role.json", expected: resolve("sessions/role.json") },
    { input: "~/sessions/role.json", expected: join(home, "sessions/role.json") },
    { input: "/saved/role.json", expected: "/saved/role.json" },
  ])("uses the explicit login --out $input", async ({ input, expected }) => {
    process.argv = [process.execPath, resolve("src/cli.ts"), "login", scenario.url, "--out", input];

    await import("../src/cli.ts");

    expect(mocks.open).toHaveBeenCalledWith(expected, expect.any(Number), 0o600);
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(dirname(expected), { recursive: true, mode: 0o700 });
    expect(console.log).toHaveBeenCalledExactlyOnceWith(`Saved ${expected}. Do not commit this file.`);
  });

  test.each([false, true])("writes a private session with an existing file: %s", async (existing) => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const directory = join(dirname(configPath), "sessions");
    const out = join(directory, "role.json");
    await fs.mkdir(directory, { mode: 0o755 });
    await fs.chmod(directory, 0o755);
    if (existing) {
      await fs.writeFile(out, "old session with more bytes than the new state".repeat(20));
      await fs.chmod(out, 0o644);
    }
    mocks.mkdir.mockImplementation(fs.mkdir);
    mocks.chmod.mockImplementation(fs.chmod);
    mocks.open.mockImplementation(fs.open);
    process.argv = [process.execPath, resolve("src/cli.ts"), "login", scenario.url, "--out", out];

    await import("../src/cli.ts");

    expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(out, "utf8"))).toEqual(session);
  });

  test("does not overwrite the target of a real symlink", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const target = join(dirname(configPath), "target.json");
    const out = join(dirname(configPath), "session.json");
    await fs.writeFile(target, "unchanged");
    await fs.symlink(target, out);
    mocks.mkdir.mockImplementation(fs.mkdir);
    mocks.chmod.mockImplementation(fs.chmod);
    mocks.open.mockImplementation(fs.open);
    process.argv = [process.execPath, resolve("src/cli.ts"), "login", scenario.url, "--out", out];

    await expect(import("../src/cli.ts")).rejects.toMatchObject({ code: "ELOOP" });

    expect(await fs.readFile(target, "utf8")).toBe("unchanged");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  test("rejects a symlink destination without writing the session", async () => {
    process.argv = [process.execPath, resolve("src/cli.ts"), "login", scenario.url];
    mocks.open.mockRejectedValue(Object.assign(new Error("Symbolic link refused"), { code: "ELOOP" }));

    await expect(import("../src/cli.ts")).rejects.toThrow("Symbolic link refused");

    expect(mocks.open.mock.calls[0]![1] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(mocks.fileWrite).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  test.each(["fileChmod", "fileWrite"] as const)("closes the file and browser when %s fails", async (operation) => {
    process.argv = [process.execPath, resolve("src/cli.ts"), "login", scenario.url];
    mocks[operation].mockRejectedValue(new Error("Cannot save session"));

    await expect(import("../src/cli.ts")).rejects.toThrow("Cannot save session");

    expect(mocks.fileClose).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
    if (operation === "fileChmod") expect(mocks.fileWrite).not.toHaveBeenCalled();
  });
});
