import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRunDir, writeReport, type RunReport, type Turn } from "../src/report.ts";
import { parseUploadConfig, uploadRunArtifacts } from "../src/upload.ts";

const env = {
  QAVO_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  QAVO_S3_BUCKET: "private-artifacts",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
};
const roots: string[] = [];
const requests: Request[] = [];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  requests.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    if (!(input instanceof Request)) throw new Error("Expected a signed Request.");
    requests.push(input);
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifacts(screenshots: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "qavo-upload-test-"));
  roots.push(root);
  const { id, dir } = await createRunDir(root);
  const turns: Turn[] = screenshots.map((screenshot, i) => ({
    n: i + 1,
    url: "https://example.test",
    fingerprint: "fixture",
    page: { title: "Fixture", elements: 0, text: "" },
    decision: {
      operation: "DONE",
      confidence: 1,
      answers: { operation: { choice: "DONE", confidence: 1, probabilities: { DONE: 1 } } },
      latencyMs: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      request: { state: {}, questions: {} },
    },
    outcome: "done",
    screenshot,
    label: null,
  }));
  const report: RunReport = {
    id,
    scenario: "Fixture",
    url: "https://example.test",
    status: "pass",
    startedAt: "2026-09-20T00:00:00.000Z",
    durationMs: 1,
    usage: { jevRequests: 1, jevInputTokens: 1, jevOutputTokens: 1, textModelCalls: 0, textModelInputTokens: 0, textModelOutputTokens: 0 },
    steps: [{ intent: "Finish", status: "pass", durationMs: 1, turns }],
  };
  for (const screenshot of screenshots) await writeFile(join(dir, screenshot), `image:${screenshot}`);
  await writeReport(dir, report);
  return { root, dir, report };
}

describe("parseUploadConfig", () => {
  test("does not enable upload from AWS credentials alone", () => {
    expect(parseUploadConfig({})).toBeUndefined();
    expect(parseUploadConfig({ AWS_ACCESS_KEY_ID: "key", AWS_SECRET_ACCESS_KEY: "secret" })).toBeUndefined();
  });

  test("defaults to auto region and no prefix without exposing credentials", () => {
    expect(parseUploadConfig(env)).toEqual({ endpoint: env.QAVO_S3_ENDPOINT, bucket: env.QAVO_S3_BUCKET, region: "auto", prefix: "" });
  });

  test("supports an endpoint path, a prefix, a region and a session token", () => {
    expect(parseUploadConfig({ ...env, QAVO_S3_ENDPOINT: "https://s3.example.test/api/", QAVO_S3_PREFIX: "qa/release-1/", QAVO_S3_REGION: "eu-west-1", AWS_SESSION_TOKEN: "token" })).toEqual({
      endpoint: "https://s3.example.test/api", bucket: env.QAVO_S3_BUCKET, region: "eu-west-1", prefix: "qa/release-1",
    });
  });

  test.each([
    { QAVO_S3_ENDPOINT: env.QAVO_S3_ENDPOINT },
    { QAVO_S3_BUCKET: env.QAVO_S3_BUCKET },
    { QAVO_S3_REGION: "auto" },
    { QAVO_S3_PREFIX: "qa" },
    { QAVO_S3_ENDPOINT: "", QAVO_S3_BUCKET: "" },
  ])("rejects partial upload configuration: %j", (partial) => {
    expect(() => parseUploadConfig(partial)).toThrow("Upload requires QAVO_S3_ENDPOINT and QAVO_S3_BUCKET.");
  });

  test.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])("requires %s before upload", (name) => {
    expect(() => parseUploadConfig({ ...env, [name]: undefined })).toThrow("Upload requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
    expect(() => parseUploadConfig({ ...env, [name]: " " })).toThrow("Upload requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
  });

  test.each([
    "http://s3.example.test", "https://user:secret@s3.example.test", "https://@s3.example.test",
    "https://s3.example.test?key=secret", "https://s3.example.test#secret", "https://s3.example.test?", "https://s3.example.test#",
    "https://s3.example.test/a/../b", "https://s3.example.test/a/./b", "https://s3.example.test/%2e%2e/b",
    "https://s3.example.test/%252e%252e/b", "https://s3.example.test/a%2fb", "https://s3.example.test/a\\b",
    "https://s3.example.test/a//b", "https://s3.example.test//", "https://s3.example.test/\npath", "https://[invalid",
  ])("rejects an unsafe endpoint: %s", (endpoint) => {
    expect(() => parseUploadConfig({ ...env, QAVO_S3_ENDPOINT: endpoint })).toThrow(/QAVO_S3_ENDPOINT/);
  });

  test.each(["..", "../qa", "qa/../other", "qa/./other", "/qa", "/", "qa//other", "qa//", "qa\\other", "%2e%2e", "qa?secret", "qa#secret", "qa\nother"])("rejects unsafe prefix: %s", (prefix) => {
    expect(() => parseUploadConfig({ ...env, QAVO_S3_PREFIX: prefix })).toThrow("QAVO_S3_PREFIX must contain safe relative path segments.");
  });

  test.each(["../bucket", "bucket/path", "bucket?secret", "bucket..name", "192.168.0.1", "UPPERCASE"])("rejects unsafe bucket: %s", (bucket) => {
    expect(() => parseUploadConfig({ ...env, QAVO_S3_BUCKET: bucket })).toThrow("QAVO_S3_BUCKET must be a valid bucket name.");
  });

  test("rejects unsafe regions and empty session tokens", () => {
    expect(() => parseUploadConfig({ ...env, QAVO_S3_REGION: "auto/secret" })).toThrow("QAVO_S3_REGION is invalid.");
    expect(() => parseUploadConfig({ ...env, AWS_SESSION_TOKEN: " " })).toThrow("AWS_SESSION_TOKEN must not be empty when provided.");
  });
});

describe("uploadRunArtifacts", () => {
  test("signs private PUT requests and uploads only referenced screenshots before the report", async () => {
    const { dir, report } = await artifacts(["step1-turn01.jpg", "step12-turn100.jpg"]);
    report.steps[0]!.turns.push(report.steps[0]!.turns[0]!);
    await writeReport(dir, report);
    await writeFile(join(dir, "step1-turn02.jpg"), "unreferenced");
    await writeFile(join(dir, "storageState.json"), "private cookies");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "report.json"), "unrelated");
    await symlink(join(dir, "storageState.json"), join(dir, "unused-link"));
    const location = await uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env);
    expect(location).toBe(`s3://private-artifacts/${report.id}/report.json`);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/private-artifacts/${report.id}/step1-turn01.jpg`, `/private-artifacts/${report.id}/step12-turn100.jpg`, `/private-artifacts/${report.id}/report.json`,
    ]);
    for (const request of requests) {
      expect(request.method).toBe("PUT");
      expect(request.redirect).toBe("error");
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.+, Signature=[a-f0-9]{64}$/);
      expect(request.headers.has("x-amz-acl")).toBe(false);
      expect(request.headers.has("x-amz-security-token")).toBe(false);
      expect(new URL(request.url).search).toBe("");
    }
    expect(requests[0]!.headers.get("content-type")).toBe("image/jpeg");
    expect(await requests[0]!.text()).toBe("image:step1-turn01.jpg");
    expect(requests[2]!.headers.get("content-type")).toBe("application/json");
    expect(await requests[2]!.text()).toBe(await readFile(join(dir, "report.json"), "utf8"));
    expect(await readFile(join(dir, "storageState.json"), "utf8")).toBe("private cookies");
  });

  test("uses the configured region, endpoint path, prefix and session token", async () => {
    const { dir, report } = await artifacts();
    const configured = { ...env, QAVO_S3_ENDPOINT: "https://s3.example.test/api/", QAVO_S3_REGION: "eu-west-1", QAVO_S3_PREFIX: "qa/release-1/", AWS_SESSION_TOKEN: "test-session-token" };
    const location = await uploadRunArtifacts(dir, report, parseUploadConfig(configured)!, configured);
    const request = requests[0]!;
    expect(request.url).toBe(`https://s3.example.test/api/private-artifacts/qa/release-1/${report.id}/report.json`);
    expect(request.headers.get("authorization")).toContain("/eu-west-1/s3/aws4_request");
    expect(request.headers.get("x-amz-security-token")).toBe("test-session-token");
    expect(location).toBe(`s3://private-artifacts/qa/release-1/${report.id}/report.json`);
  });

  test.each(["../secret.jpg", "/step1-turn01.jpg", "nested/step1-turn01.jpg", "step1-turn01.jpg/../secret", "step1-turn01.jpg?key=x", "step1-turn01.jpg\n", "step0-turn01.jpg", "step1-turn00.jpg", "step1-turn1.jpg", "step01-turn01.jpg", "step1-turn001.jpg", "storageState.json", "%2e%2e", "step1-turn01.png", ""])("rejects invalid screenshot name: %s", async (filename) => {
    const { dir, report } = await artifacts(["step1-turn01.jpg"]);
    report.steps[0]!.turns[0]!.screenshot = filename;
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("The report contains an invalid screenshot filename.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["report.json", "step1-turn01.jpg"])("rejects a symlink for %s before any upload", async (filename) => {
    const { root, dir, report } = await artifacts(["step1-turn01.jpg"]);
    const secret = join(root, "secret");
    await writeFile(secret, "private credential");
    await rm(join(dir, filename));
    await symlink(secret, join(dir, filename));
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("Artifact upload failed. Local files were preserved.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(secret, "utf8")).toBe("private credential");
  });

  test("rejects a symlink run directory", async () => {
    const { root, dir, report } = await artifacts();
    const link = join(root, "link");
    await symlink(dir, link);
    await expect(uploadRunArtifacts(link, report, parseUploadConfig(env)!, env)).rejects.toThrow("Artifact upload failed.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["missing", "directory"])("rejects %s artifacts before any upload", async (kind) => {
    const { dir, report } = await artifacts(["step1-turn01.jpg"]);
    await rm(join(dir, "report.json"));
    if (kind === "directory") await mkdir(join(dir, "report.json"));
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("Artifact upload failed.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["../other", "a/b", "..", "id?key=x"])("rejects unsafe run ID: %s", async (id) => {
    const { dir, report } = await artifacts();
    report.id = id;
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("The run ID is invalid for upload.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([302, 403, 500])("does not retry or upload the report after HTTP %s and preserves all local files", async (status) => {
    const { dir, report } = await artifacts(["step1-turn01.jpg"]);
    const filenames = await readdir(dir);
    const contents = await Promise.all(filenames.map((filename) => readFile(join(dir, filename))));
    const response = new Response("provider response with test-secret-key and signed URL", { status });
    const readBody = vi.spyOn(response, "text");
    fetchMock.mockResolvedValue(response);
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow(/^Artifact upload failed\. Local files were preserved\.$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readBody).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(filenames);
    expect(await Promise.all(filenames.map((filename) => readFile(join(dir, filename))))).toEqual(contents);
  });

  test("preserves screenshots and the report when the final report upload fails", async () => {
    const { dir, report } = await artifacts(["step1-turn01.jpg"]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("Artifact upload failed.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFile(join(dir, "step1-turn01.jpg"), "utf8")).toBe("image:step1-turn01.jpg");
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8"))).toEqual(report);
  });

  test("rejects a screenshot replaced with a symlink after the initial checks", async () => {
    const { root, dir, report } = await artifacts(["step1-turn01.jpg", "step1-turn02.jpg"]);
    const secret = join(root, "secret");
    await writeFile(secret, "private credential");
    fetchMock.mockImplementationOnce(async () => {
      await rm(join(dir, "step1-turn02.jpg"));
      await symlink(secret, join(dir, "step1-turn02.jpg"));
      return new Response(null, { status: 200 });
    });
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("Artifact upload failed.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("sanitizes fetch errors without a cause", async () => {
    const { dir, report } = await artifacts();
    fetchMock.mockRejectedValue(new Error("test-access-key test-secret-key https://signed.example.test?signature=private"));
    const result = uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env);
    await expect(result).rejects.toThrow(/^Artifact upload failed\. Local files were preserved\.$/);
    await expect(result).rejects.not.toHaveProperty("cause");
  });

  test("uses a bounded timeout and preserves files after abort", async () => {
    const { dir, report } = await artifacts();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetchMock.mockImplementation(async (input) => {
      if (!(input instanceof Request)) throw new Error("Expected a signed Request.");
      controller.abort();
      input.signal.throwIfAborted();
      return new Response();
    });
    await expect(uploadRunArtifacts(dir, report, parseUploadConfig(env)!, env)).rejects.toThrow("Artifact upload failed.");
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8"))).toEqual(report);
  });
});
