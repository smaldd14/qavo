import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { SystemOneRequest } from "@typesafe-ai/sdk";
import type { Page } from "playwright-core";
import type { Jev } from "../src/jev/answers.ts";
import { runScenario } from "../src/run.ts";
import { Limits, Scenario } from "../src/scenario.ts";
import type { TextModel } from "../src/values.ts";
import { useFixtureBrowser } from "./browser.ts";

const fixtures = useFixtureBrowser();

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
    const { jev } = scriptedJev([{ operation: "CLICK", target: "Save and next" }, { operation: "DONE" }, { expect: 0.9 }]);
    const { report } = await run(page, scenario, jev);
    expect(report.status).toBe("pass");
    expect(await page.textContent("h2")).toBe("21 Aberdeen Ave");
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
    const page = await fixtures.open("table.html");
    await page.evaluate(`document.querySelectorAll("button").forEach((b) => b.replaceWith(b.cloneNode(true)))`);
    const scenario: Scenario = { name: "stuck", url: page.url(), steps: [{ intent: "Edit WO-1", actionLimit: 10 }] };
    const { jev } = scriptedJev(Array.from({ length: 3 }, () => ({ operation: "CLICK", target: "Delete WO-1" })));
    const { report } = await run(page, scenario, jev);
    expect(report).toMatchObject({ status: "blocked", reason: "Step 1: 3 actions in a row did not change the page." });
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
