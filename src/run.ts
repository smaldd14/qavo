import { join } from "node:path";
import { noul } from "@typesafe-ai/sdk";
import type { Page } from "playwright-core";
import { act, isAllowedUrl, Refused, type Action } from "./browser/act.ts";
import { snapshot, type Snapshot } from "./browser/snapshot.ts";
import { parseNoul, type Jev } from "./jev/answers.ts";
import { decide, type Decision, type HistoryEntry } from "./jev/decide.ts";
import { EXPECT_RULES } from "./jev/prompts.ts";
import type { RunReport, Status, StepReport, Turn } from "./report.ts";
import type { Limits, Scenario, Step } from "./scenario.ts";
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
  const { page, scenario, url, id } = options;
  const started = Date.now();
  const report: RunReport = {
    id,
    scenario: scenario.name,
    url,
    status: "pass",
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    usage: { jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0, textModelCalls: 0 },
    steps: [],
  };
  await page.goto(url);
  for (const step of scenario.steps) {
    const stepReport = await runStep(options, step, report);
    report.steps.push(stepReport);
    if (stepReport.status !== "pass") {
      report.status = stepReport.status;
      report.reason = `Step ${report.steps.length}: ${stepReport.reason ?? stepReport.status}`;
      break;
    }
  }
  report.durationMs = Date.now() - started;
  return report;
}

async function runStep(options: RunOptions, step: Step, report: RunReport): Promise<StepReport> {
  const { page, jev, limits } = options;
  const started = Date.now();
  const turns: Turn[] = [];
  const history: HistoryEntry[] = [];
  let actions = 0;
  let refusalsInRow = 0;
  let lastFingerprint: string | undefined;

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

    const state = await snapshot(page);
    const previous = history.at(-1);
    if (previous && previous.pageChanged === null) {
      previous.pageChanged = state.fingerprint !== lastFingerprint;
      turns.at(-1)!.pageChanged = previous.pageChanged;
    }
    const stuck = history.slice(-limits.stuckActions);
    if (stuck.length === limits.stuckActions && stuck.every((h) => h.operation !== "WAIT" && h.pageChanged === false)) {
      return end({ status: "blocked", reason: `${limits.stuckActions} actions in a row did not change the page.` });
    }
    lastFingerprint = state.fingerprint;

    const decision = await decide(jev, state, step.intent, history);
    countJev(decision.usage);
    const turn = turnFor(turns.length + 1, state, decision);
    turns.push(turn);

    if (decision.confidence < limits.confidence) {
      turn.outcome = "unclear";
      return end({
        status: "unclear",
        reason: `Confidence ${decision.confidence.toFixed(2)} for ${decision.operation} is below ${limits.confidence}.`,
      });
    }
    if (decision.operation === "BLOCKED") {
      turn.outcome = "blocked";
      return end({ status: "blocked", reason: "Jev chose BLOCKED." });
    }
    if (decision.operation === "DONE") {
      turn.outcome = "done";
      turn.screenshot = await screenshot(page, options.dir, report, turns.length);
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
        const value = await valueFor({ jev, textModel: options.textModel, step, element: decision.target.element, page: state, history });
        if (value.source === "data") countJev(value.usage);
        else report.usage.textModelCalls++;
        const text = decision.target.element.sensitive ? MASK : value.text;
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
    turn.screenshot = await screenshot(page, options.dir, report, turns.length);
    history.push({
      operation: decision.operation,
      ...("target" in decision && { element: `[${decision.target.label}] ${decision.target.element.name}${decision.target.option ? ` → ${decision.target.option.label}` : ""}` }),
      ...(typed !== undefined && { text: typed }),
      pageChanged: null,
    });
  }
}

function turnFor(n: number, state: Snapshot, decision: Decision): Turn {
  return {
    n,
    url: state.url,
    fingerprint: state.fingerprint,
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
      elements: state.elements.map((e) => ({
        name: e.name,
        role: e.role,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.checked !== undefined && { checked: e.checked }),
        ...(e.selected !== undefined && { selected: e.selected }),
      })),
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
