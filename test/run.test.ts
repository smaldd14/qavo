import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as snapshots from "../src/browser/snapshot.ts";
import type { SystemOneRequest } from "@typesafe-ai/sdk";
import type { Page } from "playwright-core";
import type { Jev } from "../src/jev/answers.ts";
import { runScenario } from "../src/run.ts";
import { Limits, Scenario } from "../src/scenario.ts";
import type { TextModel } from "../src/values.ts";
import { useFixtureBrowser } from "./browser.ts";

const fixtures = useFixtureBrowser();

afterEach(() => vi.restoreAllMocks());

type Scripted =
  | { operation: string; target?: string; confidence?: number }
  | { dataKey: string }
  | { expect: number };

type Criteria = Record<string, { element?: string } | string | null>;

const answer = (choice: string, labels: string[], confidence = 0.95) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? confidence : (1 - confidence) / Math.max(1, labels.length - 1)])),
});

/** A fake Jev that answers from a script, in order. A target is the element name as the target head shows it. */
function scriptedJev(script: Scripted[]) {
  const queue = [...script];
  const requests: SystemOneRequest[] = [];
  const jev: Jev = {
    async systemOne(request) {
      requests.push(request);
      const next = queue.shift();
      const questions = request.questions as Record<string, { criteria?: Criteria }>;
      const usage = { input_tokens: 100, output_tokens: 1 };
      if (questions.expect) {
        if (!next || !("expect" in next)) throw new Error(`Script expected ${JSON.stringify(next)}, got an expect check`);
        return { model: "fake", usage, answers: { expect: { type: "noul", noul: next.expect } } };
      }
      if (questions.data_key) {
        if (!next || !("dataKey" in next)) throw new Error(`Script expected ${JSON.stringify(next)}, got a data_key question`);
        return { model: "fake", usage, answers: { data_key: answer(next.dataKey, Object.keys(questions.data_key.criteria!)) } };
      }
      if (!next || !("operation" in next)) throw new Error(`Script expected ${JSON.stringify(next)}, got an operation question`);
      const answers: Record<string, unknown> = {
        operation: answer(next.operation, Object.keys(questions.operation!.criteria!), next.confidence),
      };
      if (next.target) {
        const head = questions[`${next.operation}_target`]!.criteria!;
        const label = Object.entries(head).find(
          ([label, c]) => typeof c === "object" && c?.element === `[${label}] ${next.target}`,
        )?.[0];
        if (!label) throw new Error(`No offered target named ${next.target}: ${JSON.stringify(Object.values(head))}`);
        answers[`${next.operation}_target`] = answer(label, Object.keys(head));
      }
      return { model: "fake", usage, answers };
    },
  };
  return { jev, requests, remaining: () => queue.length };
}

function scenarioFrom(example: string): Scenario {
  const scenario = Scenario.parse(JSON.parse(readFileSync(new URL(`../examples/${example}`, import.meta.url), "utf8")));
  return { ...scenario, url: new URL(new URL(scenario.url).pathname, fixtures.baseUrl()).href };
}

async function run(page: Page, scenario: Scenario, jev: Jev, textModel?: TextModel) {
  const dir = mkdtempSync(join(tmpdir(), "qavo-run-"));
  const report = await runScenario({
    page,
    jev,
    textModel,
    scenario,
    url: scenario.url,
    allowHosts: ["127.0.0.1"],
    limits: Limits.parse({}),
    id: "test",
    dir,
  });
  return { report, dir };
}

describe("runScenario", () => {
  test("passes a 3-step scenario, with values from data and from the text model", async () => {
    const page = await fixtures.open("form.html");
    const { jev, remaining } = scriptedJev([
      { operation: "TYPE_TEXT", target: "Full name" },
      { dataKey: "full name" },
      { operation: "DONE" },
      { operation: "SELECT", target: "Topic → Billing" },
      { operation: "DONE" },
      { operation: "TYPE_TEXT", target: "Message" },
      { operation: "CLICK", target: "Send message" },
      { operation: "DONE" },
      { expect: 0.96 },
    ]);
    const textModel = vi.fn<TextModel>(async () => ({ text: "Please send a copy of the last invoice.", model: "fake-text" }));
    const { report, dir } = await run(page, scenarioFrom("fixture-contact.json"), jev, textModel);

    expect(report.status).toBe("pass");
    expect(remaining()).toBe(0);
    expect(report.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);
    expect(await page.textContent("#status")).toBe("Thanks, Ada Lovelace. Message sent.");
    expect(await page.inputValue("#message")).toBe("Please send a copy of the last invoice.");

    const values = report.steps.flatMap((s) => s.turns).flatMap((t) => (t.value ? [t.value] : []));
    expect(values).toMatchObject([
      { text: "Ada Lovelace", source: "data", key: "full name" },
      { text: "Please send a copy of the last invoice.", source: "model", model: "fake-text" },
    ]);
    expect(textModel).toHaveBeenCalledOnce();
    expect(report.steps[2]!.expect).toMatchObject({ probability: 0.96 });
    expect(report.usage).toMatchObject({ jevRequests: 9, textModelCalls: 1 });
    for (const turn of report.steps.flatMap((s) => s.turns)) {
      expect(existsSync(join(dir, turn.screenshot!))).toBe(true);
    }
  });

  test("passes the 1-step hotel goal", async () => {
    const page = await fixtures.open("hotel.html");
    const { jev } = scriptedJev([
      { operation: "TYPE_TEXT", target: "Destination" },
      { dataKey: "destination" },
      { operation: "CLICK", target: "Free cancellation" },
      { operation: "CLICK", target: "Search" },
      { operation: "DONE" },
      { expect: 0.9 },
    ]);
    const { report } = await run(page, scenarioFrom("fixture-hotel.json"), jev);
    expect(report.status).toBe("pass");
    expect(await page.textContent("#count")).toBe("1 stays in Lisbon with free cancellation");
    expect(report.steps[0]!.turns.map((t) => [t.decision.operation, t.outcome, t.pageChanged])).toEqual([
      ["TYPE_TEXT", "acted", true],
      ["CLICK", "acted", true],
      ["CLICK", "acted", true],
      ["DONE", "done", undefined],
    ]);
  });

  test("waits for an app that renders after load and fetches its data", async () => {
    const page = await fixtures.open("spa.html");
    const scenario: Scenario = {
      name: "spa",
      url: page.url(),
      steps: [{ intent: "Save the first account and move to the next", expect: "The page shows 21 Aberdeen Ave", actionLimit: 3 }],
    };
    const { jev, requests } = scriptedJev([{ operation: "CLICK", target: "Save and next" }, { operation: "DONE" }, { expect: 0.9 }]);
    const { report } = await run(page, scenario, jev);
    expect(report.status).toBe("pass");
    expect(await page.textContent("h2")).toBe("21 Aberdeen Ave");

    // The decision after the save sees what the save changed. The next item alone does not show that the step is done.
    const [recent] = (requests[1]!.state as { recent_actions: unknown[] }).recent_actions;
    expect(recent).toEqual({
      operation: "CLICK",
      element: expect.stringContaining("Save and next"),
      page_changed: true,
      page_changes: { removed: ["2 left", "112 Automotive Blvd"], added: ["1 left", "21 Aberdeen Ave"] },
    });
    expect(report.steps[0]!.turns[0]!.decision.request).toEqual(requests[0]);
  });

  test.each([
    { name: "fallback", text: "12.00", usage: { inputTokens: 23, outputTokens: 4 }, model: true, data: true },
    { name: "fallback without token usage", text: "12.00", usage: undefined, model: true, data: true },
    { name: "model has no value", text: null, usage: { inputTokens: 23, outputTokens: 4 }, model: true, data: true },
    { name: "model has no value or token usage", text: null, usage: undefined, model: true, data: false },
    { name: "no model configured", text: null, usage: undefined, model: false, data: true },
  ])("counts all value requests: $name", async ({ text, usage, model, data }) => {
    const page = await fixtures.open("spa.html");
    const scenario: Scenario = {
      name: "value usage",
      url: page.url(),
      steps: [{ intent: "Enter the amount", ...(data && { data: { unrelated: "unused" } }), actionLimit: 3 }],
    };
    const script: Scripted[] = [{ operation: "TYPE_TEXT", target: "Owed at takeover" }];
    if (data) script.push({ dataKey: "none" });
    if (text !== null) script.push({ operation: "DONE" });
    const { jev, requests, remaining } = scriptedJev(script);
    const textModel = vi.fn<TextModel>(async () => ({ text, model: "fake-text", usage }));
    const { report, dir } = await run(page, scenario, jev, model ? textModel : undefined);
    expect(report.status).toBe(text === null ? "blocked" : "pass");
    expect(remaining()).toBe(0);
    expect(report.usage).toEqual({
      jevRequests: requests.length,
      jevInputTokens: requests.length * 100,
      jevOutputTokens: requests.length,
      textModelCalls: model ? 1 : 0,
      textModelInputTokens: usage?.inputTokens ?? 0,
      textModelOutputTokens: usage?.outputTokens ?? 0,
    });
    expect(textModel).toHaveBeenCalledTimes(model ? 1 : 0);
    if (text === null) {
      const turn = report.steps[0]!.turns[0]!;
      expect(turn.outcome).toBe("no_value");
      expect(turn.value).toBeUndefined();
      expect(existsSync(join(dir, turn.screenshot!))).toBe(true);
    }
  });

  test("expectations omit sensitive values and retain element state on the SPA", async () => {
    const page = await fixtures.open("spa.html");
    const settledSnapshot = snapshots.settledSnapshot;
    vi.spyOn(snapshots, "settledSnapshot").mockImplementation(async (page) => {
      const state = await settledSnapshot(page);
      state.elements.push({
        index: 100,
        name: "Private field",
        role: "textbox",
        sensitive: true,
        value: "private-value",
        operations: ["TYPE_TEXT"],
      }, {
        index: 101,
        name: "Account state",
        role: "combobox",
        value: "Open",
        checked: false,
        selected: true,
        expanded: false,
        pressed: "mixed",
        context: "Account details",
        operations: ["SELECT"],
        options: [{ value: "open", label: "Open" }],
      });
      return state;
    });
    const scenario: Scenario = {
      name: "safe expectation",
      url: page.url(),
      steps: [{ intent: "Inspect the account", expect: "The account is open", actionLimit: 3 }],
    };
    const { jev, requests } = scriptedJev([{ operation: "DONE" }, { expect: 0.9 }]);
    const { report } = await run(page, scenario, jev);
    expect(report.status).toBe("pass");
    expect(JSON.stringify(requests)).not.toContain("private-value");
    expect(requests[1]!.state).toMatchObject({ elements: expect.arrayContaining([
      expect.objectContaining({ name: "Private field", role: "textbox", sensitive: true }),
      expect.objectContaining({
        name: "Account state", role: "combobox", value: "Open", checked: false,
        selected: true, expanded: false, pressed: "mixed", context: "Account details",
      }),
    ]) });
    expect(report.usage).toMatchObject({ jevRequests: 2, jevInputTokens: 200, jevOutputTokens: 2 });
  });

  test("does not attribute a successful action's changes to a later refusal on the SPA", async () => {
    const page = await fixtures.open("spa.html");
    const scenario: Scenario = {
      name: "refusal attribution",
      url: page.url(),
      steps: [{ intent: "Save the accounts", actionLimit: 4 }],
    };
    const scripted = scriptedJev([
      { operation: "CLICK", target: "Save and next" },
      { operation: "CLICK", target: "Save and next" },
      { operation: "CLICK", target: "Save and next" },
      { operation: "DONE" },
    ]);
    const jev: Jev = {
      async systemOne(request) {
        const result = await scripted.jev.systemOne(request);
        if (scripted.requests.length === 2) await page.locator("#amount").fill("1.00");
        return result;
      },
    };
    const { report } = await run(page, scenario, jev);
    expect(report.status).toBe("pass");
    const turns = report.steps[0]!.turns;
    expect(turns.map((turn) => [turn.outcome, turn.pageChanged])).toEqual([
      ["acted", true], ["refused", undefined], ["acted", true], ["done", undefined],
    ]);
    expect(turns[1]!.refusal).toMatch(/^stale:/);
    expect(turns[1]!.changes).toBeUndefined();
    expect(turns[0]!.changes).toEqual({ removed: ["2 left", "112 Automotive Blvd"], added: ["1 left", "21 Aberdeen Ave"] });
    const afterRefusal = scripted.requests[2]!.state as { recent_actions: unknown[] };
    expect(afterRefusal.recent_actions).toHaveLength(1);
    expect(afterRefusal.recent_actions[0]).toMatchObject({ page_changed: true, page_changes: turns[0]!.changes });
    expect(turns[2]!.changes?.added).toContain("0 left");
  });

  test("fails when the expect check says no", async () => {
    const page = await fixtures.open("hotel.html");
    const { jev } = scriptedJev([{ operation: "DONE" }, { expect: 0.05 }]);
    const { report } = await run(page, scenarioFrom("fixture-hotel.json"), jev);
    expect(report).toMatchObject({ status: "fail", reason: "Step 1: The expect check said no." });
  });

  test("is unclear when the expect probability is between the thresholds", async () => {
    const page = await fixtures.open("hotel.html");
    const { jev } = scriptedJev([{ operation: "DONE" }, { expect: 0.5 }]);
    const { report } = await run(page, scenarioFrom("fixture-hotel.json"), jev);
    expect(report.status).toBe("unclear");
  });

  test("stops as unclear when a decision has low confidence, before any action", async () => {
    const page = await fixtures.open("hotel.html");
    const { jev } = scriptedJev([{ operation: "CLICK", target: "Search", confidence: 0.3 }]);
    const { report } = await run(page, scenarioFrom("fixture-hotel.json"), jev);
    expect(report.status).toBe("unclear");
    expect(report.steps[0]!.turns[0]!.outcome).toBe("unclear");
    expect(await page.textContent("#count")).toBe("4 stays");
  });

  test("is blocked when Jev chooses BLOCKED", async () => {
    const page = await fixtures.open("hotel.html");
    const { jev } = scriptedJev([{ operation: "BLOCKED" }]);
    const { report, dir } = await run(page, scenarioFrom("fixture-hotel.json"), jev);
    expect(report).toMatchObject({ status: "blocked", reason: "Step 1: Jev chose BLOCKED." });
    const turn = report.steps[0]!.turns[0]!;
    expect(existsSync(join(dir, turn.screenshot!))).toBe(true);
    expect(turn.page).toMatchObject({ title: "Harbor Stays", elements: 8 });
  });

  test("is blocked at the action limit", async () => {
    const page = await fixtures.open("hotel.html");
    const scenario = scenarioFrom("fixture-hotel.json");
    scenario.steps[0]!.actionLimit = 2;
    const { jev } = scriptedJev([{ operation: "WAIT" }, { operation: "WAIT" }]);
    const { report } = await run(page, scenario, jev);
    expect(report).toMatchObject({ status: "blocked", reason: "Step 1: The step reached its limit of 2 actions." });
  });

  test("is blocked when actions do not change the page", async () => {
    const page = await fixtures.open("hidden.html");
    const scenario: Scenario = { name: "stuck", url: page.url(), steps: [{ intent: "Press the button", actionLimit: 10 }] };
    const { jev } = scriptedJev(Array.from({ length: 3 }, () => ({ operation: "CLICK", target: "Visible button" })));
    const { report } = await run(page, scenario, jev);
    expect(report).toMatchObject({ status: "blocked", reason: "Step 1: 3 actions in a row did not change the page." });
  });

  test("keeps env data out of later models and reports across SPA steps", async () => {
    vi.stubEnv("QA_AMOUNT", "123.45");
    const page = await fixtures.open("spa.html");
    const scenario: Scenario = {
      name: "env data", url: page.url(), steps: [
        { intent: "Enter the amount", data: { amount: "@env:QA_AMOUNT" }, actionLimit: 3 },
        { intent: "Inspect the amount", expect: "The amount is present", actionLimit: 3 },
      ],
    };
    const { jev, requests } = scriptedJev([
      { operation: "TYPE_TEXT", target: "Owed at takeover" }, { dataKey: "amount" }, { operation: "DONE" },
      { operation: "TYPE_TEXT", target: "Owed at takeover" }, { operation: "DONE" }, { expect: 0.9 },
    ]);
    const textModel = vi.fn<TextModel>(async () => ({ text: "0", model: "fake" }));
    try {
      const { report } = await run(page, scenario, jev, textModel);
      expect(report.status).toBe("pass");
      expect(report.steps[0]!.turns[0]!.value).toMatchObject({ text: "***", source: "data", key: "amount" });
      expect(JSON.stringify(requests)).not.toContain("123.45");
      expect(JSON.stringify(textModel.mock.calls)).not.toContain("123.45");
      expect(JSON.stringify(report)).not.toContain("123.45");
      expect(report.steps.flatMap((step) => step.turns).every((turn) => turn.screenshot === undefined)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a password field never reaches the text model, and its value is masked", async () => {
    const page = await fixtures.open("form.html");
    const textModel = vi.fn<TextModel>(async () => ({ text: "guess", model: "fake-text" }));
    const noData: Scenario = { name: "no data", url: page.url(), steps: [{ intent: "Enter the password", actionLimit: 3 }] };
    const first = await run(page, noData, scriptedJev([{ operation: "TYPE_TEXT", target: "Password" }]).jev, textModel);
    expect(first.report.status).toBe("blocked");
    expect(first.report.reason).toMatch(/password field/);
    expect(textModel).not.toHaveBeenCalled();

    const withData: Scenario = {
      name: "data",
      url: page.url(),
      steps: [{ intent: "Enter the password", data: { password: "hunter2" }, actionLimit: 3 }],
    };
    const { jev, requests } = scriptedJev([{ operation: "TYPE_TEXT", target: "Password" }, { dataKey: "password" }, { operation: "DONE" }]);
    const second = await run(page, withData, jev, textModel);
    expect(second.report.status).toBe("pass");
    expect(await page.inputValue("#password")).toBe("hunter2");
    expect(JSON.stringify(second.report)).not.toContain("hunter2");
    expect(JSON.stringify(requests)).not.toContain("hunter2");
  });
});
