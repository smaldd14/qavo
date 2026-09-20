import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemOneRequest, Usage } from "@typesafe-ai/sdk";
import type { Operation } from "./browser/snapshot.ts";
import type { ChoiceAnswer } from "./jev/answers.ts";
import type { Control } from "./jev/decide.ts";

export type Status = "pass" | "fail" | "blocked" | "unclear";

/** One decision and what code did with it. */
export interface Turn {
  n: number;
  url: string;
  fingerprint: string;
  /** What Jev saw: the control count and the start of the page text. */
  page: { title: string; elements: number; text: string };
  decision: {
    operation: Operation | Control;
    target?: { label: string; index: number; name: string; option?: string };
    confidence: number;
    answers: { operation: ChoiceAnswer; target?: ChoiceAnswer };
    latencyMs: number;
    usage: Usage;
    /** The exact Jev request. `scripts/replay-turn.ts` sends it again. */
    request: SystemOneRequest;
  };
  value?: { text: string; source: "data" | "model"; key?: string; model?: string; answer?: ChoiceAnswer; latencyMs: number };
  outcome: "acted" | "refused" | "done" | "blocked" | "unclear" | "no_value";
  refusal?: string;
  screenshot?: string;
  pageChanged?: boolean;
  changes?: { removed: string[]; added: string[] };
  /** For Stage 0: set by hand to "correct" or "wrong" after a review of the screenshot. */
  label: null | "correct" | "wrong";
}

export interface StepReport {
  intent: string;
  status: Status;
  reason?: string;
  durationMs: number;
  expect?: { text: string; probability: number; latencyMs: number };
  turns: Turn[];
}

export interface RunReport {
  id: string;
  scenario: string;
  url: string;
  status: Status;
  reason?: string;
  startedAt: string;
  durationMs: number;
  usage: { jevRequests: number; jevInputTokens: number; jevOutputTokens: number; textModelCalls: number; textModelInputTokens: number; textModelOutputTokens: number };
  steps: StepReport[];
}

export async function createRunDir(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), "qavo-"));
  const id = randomUUID();
  const runs = join(root, "runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const dir = join(runs, id);
  await mkdir(dir, { mode: 0o700 });
  return { id, dir };
}

export async function writeReport(dir: string, report: RunReport) {
  const path = join(dir, "report.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
