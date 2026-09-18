import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@typesafe-ai/sdk";
import type { Operation } from "./browser/snapshot.ts";
import type { ChoiceAnswer } from "./jev/answers.ts";
import type { Control } from "./jev/decide.ts";

export type Status = "pass" | "fail" | "blocked" | "unclear";

/** One decision and what code did with it. */
export interface Turn {
  n: number;
  url: string;
  fingerprint: string;
  decision: {
    operation: Operation | Control;
    target?: { label: string; index: number; name: string; option?: string };
    confidence: number;
    answers: { operation: ChoiceAnswer; target?: ChoiceAnswer };
    latencyMs: number;
    usage: Usage;
  };
  value?: { text: string; source: "data" | "model"; key?: string; model?: string; answer?: ChoiceAnswer; latencyMs: number };
  outcome: "acted" | "refused" | "done" | "blocked" | "unclear" | "no_value";
  refusal?: string;
  screenshot?: string;
  pageChanged?: boolean;
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
  usage: { jevRequests: number; jevInputTokens: number; jevOutputTokens: number; textModelCalls: number };
  steps: StepReport[];
}

export async function createRunDir(root: string) {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, "runs", id);
  await mkdir(dir, { recursive: true });
  return { id, dir };
}

export async function writeReport(dir: string, report: RunReport) {
  const path = join(dir, "report.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
