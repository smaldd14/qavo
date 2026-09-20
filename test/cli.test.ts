import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunReport, Status } from "../src/report.ts";
import { Config, Scenario } from "../src/scenario.ts";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
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
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.existsSync,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: mocks.readFile,
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
const page = {};
let report: RunReport;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
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
  mocks.newContext.mockResolvedValue({ newPage: mocks.newPage });
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

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  process.env = originalEnv;
  vi.restoreAllMocks();
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
