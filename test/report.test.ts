import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRunDir, writeReport, type RunReport } from "../src/report.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createRunDir", () => {
  test("uses a private temporary root outside the checkout by default", async () => {
    const { id, dir } = await createRunDir();
    const root = dirname(dirname(dir));
    roots.push(root);
    expect(dir).toBe(join(root, "runs", id));
    expect(dirname(root)).toBe(tmpdir());
    expect(relative(process.cwd(), dir).startsWith("..")).toBe(true);
    for (const path of [root, dirname(dir), dir]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
  });

  test("supports an explicit root and unique IDs at the same time", async () => {
    const parent = await mkdtemp(join(tmpdir(), "qavo-report-test-"));
    roots.push(parent);
    const root = join(parent, "output");
    vi.spyOn(Date, "now").mockReturnValue(1);
    const runs = await Promise.all(Array.from({ length: 10 }, () => createRunDir(root)));
    expect(new Set(runs.map((run) => run.id)).size).toBe(10);
    for (const { id, dir } of runs) {
      expect(dir).toBe(join(root, "runs", id));
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });
});

test("writeReport writes the full JSON report with a final newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "qavo-report-test-"));
  roots.push(root);
  const { id, dir } = await createRunDir(root);
  const report: RunReport = {
    id,
    scenario: "Fixture",
    url: "https://example.test",
    status: "pass",
    startedAt: "2026-09-20T00:00:00.000Z",
    durationMs: 1,
    usage: { jevRequests: 1, jevInputTokens: 2, jevOutputTokens: 3, textModelCalls: 1, textModelInputTokens: 4, textModelOutputTokens: 5 },
    steps: [],
  };
  const path = await writeReport(dir, report);
  expect(path).toBe(join(dir, "report.json"));
  expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(report, null, 2)}\n`);
});
