import { join } from "node:path";
import { noul } from "@typesafe-ai/sdk";
import type { Page } from "playwright-core";
import { act, isAllowedUrl, Refused, type Action } from "./browser/act.ts";
import { settledSnapshot, trackRequests, type Snapshot } from "./browser/snapshot.ts";
import { parseNoul, type Jev } from "./jev/answers.ts";
import { decide, describeElement, type Decision, type HistoryEntry } from "./jev/decide.ts";
import { EXPECT_RULES } from "./jev/prompts.ts";
import type { RunReport, Status, StepReport, Turn } from "./report.ts";
import { resolveScenarioData, type Limits, type Scenario, type Step } from "./scenario.ts";
import { NoValue, valueFor, type TextModel } from "./values.ts";

export interface RunOptions {
  page: Page;
  jev: Jev;
  textModel?: TextModel;
  scenario: Scenario;
  /** The absolute start URL. */
  url: string;
  allowHosts: string[];
  limits: Limits;
  id: string;
  dir: string;
}

type StepEnd = { status: Status; reason?: string; expect?: StepReport["expect"] };

const MASK = "***";

export async function runScenario(options: RunOptions): Promise<RunReport> {
  const { page, url, id } = options;
  const { scenario, secrets } = resolveScenarioData(options.scenario);
  const patterns = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret), secret.slice(0, 200)]))]
    .sort((a, b) => b.length - a.length);
  const redact = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    return patterns.reduce((text, secret) => text.split(secret).join(MASK), item);
  }));
  const safeOptions: RunOptions = {
    ...options,
    scenario,
    jev: { systemOne: (request) => options.jev.systemOne(redact(request)) },
    textModel: options.textModel ? (context) => options.textModel!(redact(context)) : undefined,
  };
  const started = Date.now();
  const report: RunReport = {
    id,
    scenario: scenario.name,
    url,
    status: "pass",
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    usage: { jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0, textModelCalls: 0, textModelInputTokens: 0, textModelOutputTokens: 0 },
    steps: [],
  };
  trackRequests(page);
  await page.goto(url);
  for (const step of scenario.steps) {
    const stepReport = await runStep(safeOptions, step, report, secrets);
    report.steps.push(stepReport);
    if (stepReport.status !== "pass") {
      report.status = stepReport.status;
      report.reason = `Step ${report.steps.length}: ${stepReport.reason ?? stepReport.status}`;
      break;
    }
  }
  report.durationMs = Date.now() - started;
  return redact(report);
}

async function runStep(options: RunOptions, step: Step, report: RunReport, secrets: string[]): Promise<StepReport> {
  const { page, jev, limits } = options;
  const started = Date.now();
  const turns: Turn[] = [];
  const history: HistoryEntry[] = [];
  let actions = 0;
  let refusalsInRow = 0;
  let before: Snapshot | undefined;

  const countJev = (usage: { input_tokens: number; output_tokens: number }) => {
    report.usage.jevRequests++;
    report.usage.jevInputTokens += usage.input_tokens;
    report.usage.jevOutputTokens += usage.output_tokens;
  };

  const end = (result: StepEnd): StepReport => ({
    intent: step.intent,
    ...result,
    durationMs: Date.now() - started,
    turns,
  });

  while (true) {
    if (actions >= step.actionLimit) return end({ status: "blocked", reason: `The step reached its limit of ${step.actionLimit} actions.` });
    if (Date.now() - started > limits.stepSeconds * 1000) {
      return end({ status: "blocked", reason: `The step reached its limit of ${limits.stepSeconds} seconds.` });
    }
    if (!isAllowedUrl(page.url(), options.allowHosts)) {
      return end({ status: "blocked", reason: `The page left allowHosts: ${page.url()}` });
    }

    const state = await settledSnapshot(page);
    const previous = history.at(-1);
    if (previous && previous.pageChanged === null && before) {
      const changes = textChanges(before.text, state.text);
      previous.pageChanged = state.fingerprint !== before.fingerprint || changes !== undefined;
      if (changes) previous.changes = changes;
      Object.assign(turns.at(-1)!, { pageChanged: previous.pageChanged, ...(changes && { changes }) });
    }
    const stuck = history.slice(-limits.stuckActions);
    if (stuck.length === limits.stuckActions && stuck.every((h) => h.operation !== "WAIT" && h.pageChanged === false)) {
      return end({ status: "blocked", reason: `${limits.stuckActions} actions in a row did not change the page.` });
    }
    before = state;

    const decision = await decide(jev, state, step.intent, history);
    countJev(decision.usage);
    const turn = turnFor(turns.length + 1, state, decision);
    turns.push(turn);
    const capture = async () => {
      if (secrets.length === 0) turn.screenshot = await screenshot(page, options.dir, report, turn.n);
    };

    if (decision.confidence < limits.confidence) {
      turn.outcome = "unclear";
      await capture();
      return end({
        status: "unclear",
        reason: `Confidence ${decision.confidence.toFixed(2)} for ${decision.operation} is below ${limits.confidence}.`,
      });
    }
    if (decision.operation === "BLOCKED") {
      turn.outcome = "blocked";
      await capture();
      return end({ status: "blocked", reason: "Jev chose BLOCKED." });
    }
    if (decision.operation === "DONE") {
      turn.outcome = "done";
      await capture();
      if (!step.expect) return end({ status: "pass" });
      const expect = await checkExpect(jev, state, step.expect);
      countJev(expect.usage);
      const { probability } = expect;
      const result = { text: step.expect, probability, latencyMs: expect.latencyMs };
      if (probability >= limits.expectPass) return end({ status: "pass", expect: result });
      if (probability <= limits.expectFail) return end({ status: "fail", reason: "The expect check said no.", expect: result });
      return end({ status: "unclear", reason: `The expect check probability ${probability.toFixed(2)} is between the thresholds.`, expect: result });
    }

    let action: Action;
    let typed: string | undefined;
    if (decision.operation === "TYPE_TEXT") {
      try {
        const value = await valueFor({
          jev, textModel: options.textModel, step, element: decision.target.element, page: state, history,
          onUsage(event) {
            if (event.source === "jev") countJev(event.usage);
            else {
              report.usage.textModelCalls++;
              report.usage.textModelInputTokens += event.usage?.inputTokens ?? 0;
              report.usage.textModelOutputTokens += event.usage?.outputTokens ?? 0;
            }
          },
        });
        const text = decision.target.element.sensitive || secrets.includes(value.text) ? MASK : value.text;
        turn.value = {
          text,
          source: value.source,
          ...(value.source === "data" ? { key: value.key } : { model: value.model }),
          ...(value.answer && { answer: value.answer }),
          latencyMs: value.latencyMs,
        };
        typed = text;
        action = { operation: "TYPE_TEXT", index: decision.target.element.index, text: value.text };
      } catch (error) {
        if (!(error instanceof NoValue)) throw error;
        turn.outcome = "no_value";
        await capture();
        return end({ status: "blocked", reason: error.message });
      }
    } else if (decision.operation === "SELECT") {
      action = { operation: "SELECT", index: decision.target.element.index, value: decision.target.option!.value };
    } else if (decision.operation === "CLICK") {
      action = { operation: "CLICK", index: decision.target.element.index };
    } else {
      action = { operation: decision.operation };
    }

    try {
      await act(page, action, { fingerprint: state.fingerprint, allowHosts: options.allowHosts });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      turn.outcome = "refused";
      turn.refusal = `${error.reason}: ${error.message}`;
      if (error.reason === "host") return end({ status: "blocked", reason: error.message });
      if (++refusalsInRow >= limits.stuckActions) {
        return end({ status: "blocked", reason: `${refusalsInRow} actions in a row were refused. Last: ${error.message}` });
      }
      continue;
    }
    refusalsInRow = 0;
    actions++;
    turn.outcome = "acted";
    await capture();
    history.push({
      operation: decision.operation,
      ...("target" in decision && { element: `[${decision.target.label}] ${decision.target.element.name}${decision.target.option ? ` → ${decision.target.option.label}` : ""}` }),
      ...(typed !== undefined && { text: typed }),
      pageChanged: null,
    });
  }
}

const CHANGE_LINES = 8;
const CHANGE_LINE_CHARS = 120;

/** The page text lines that are only in `before` (removed) and only in `after` (added). */
function textChanges(before: string, after: string) {
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  const pick = (lines: Set<string>, other: Set<string>) =>
    [...lines].filter((line) => !other.has(line)).slice(0, CHANGE_LINES).map((line) => line.slice(0, CHANGE_LINE_CHARS));
  const removed = pick(beforeLines, afterLines);
  const added = pick(afterLines, beforeLines);
  return removed.length || added.length ? { removed, added } : undefined;
}

function turnFor(n: number, state: Snapshot, decision: Decision): Turn {
  return {
    n,
    url: state.url,
    fingerprint: state.fingerprint,
    page: { title: state.title, elements: state.elements.length, text: state.text.slice(0, 500) },
    decision: {
      operation: decision.operation,
      ...("target" in decision && {
        target: {
          label: decision.target.label,
          index: decision.target.element.index,
          name: decision.target.element.name,
          ...(decision.target.option && { option: decision.target.option.label }),
        },
      }),
      confidence: decision.confidence,
      answers: decision.answers,
      latencyMs: decision.latencyMs,
      usage: decision.usage,
      request: decision.request,
    },
    outcome: "acted",
    label: null,
  };
}

async function checkExpect(jev: Jev, state: Snapshot, expected: string) {
  const started = performance.now();
  const result = await jev.systemOne({
    state: {
      page: { url: state.url, title: state.title, text: state.text },
      elements: state.elements.map(describeElement),
    },
    questions: { expect: noul({ expected, rules: EXPECT_RULES }) },
  });
  return {
    probability: parseNoul(result.answers.expect, "expect"),
    usage: result.usage,
    latencyMs: Math.round(performance.now() - started),
  };
}

async function screenshot(page: Page, dir: string, report: RunReport, turn: number) {
  const name = `step${report.steps.length + 1}-turn${String(turn).padStart(2, "0")}.jpg`;
  await page.screenshot({ path: join(dir, name), type: "jpeg", quality: 70 });
  return name;
}
