import { describe, expect, test } from "vitest";
import type { SystemOneRequest } from "@typesafe-ai/sdk";
import type { Snapshot } from "../src/browser/snapshot.ts";
import type { Jev } from "../src/jev/answers.ts";
import { buildRequest, decide } from "../src/jev/decide.ts";

const page: Snapshot = {
  url: "http://127.0.0.1/form.html",
  title: "Contact form",
  text: "Contact us",
  omitted: 0,
  scroll: { y: 0, max: 400 },
  fingerprint: "abc",
  elements: [
    { index: 1, role: "textbox", name: "Full name", value: "", operations: ["TYPE_TEXT"] },
    { index: 2, role: "textbox", name: "Password", sensitive: true, operations: ["TYPE_TEXT"] },
    { index: 3, role: "checkbox", name: "Newsletter", checked: false, operations: ["CLICK"] },
    {
      index: 4,
      role: "combobox",
      name: "Topic",
      value: "Choose",
      operations: ["SELECT"],
      options: [
        { value: "", label: "Choose" },
        { value: "billing", label: "Billing" },
      ],
    },
    { index: 5, role: "button", name: "Send", operations: ["CLICK"] },
  ],
};

const choiceAnswer = (choice: string, labels: string[], confidence = 0.9) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? confidence : (1 - confidence) / (labels.length - 1)])),
});

function stubJev(answers: (request: SystemOneRequest) => Record<string, unknown>) {
  const requests: SystemOneRequest[] = [];
  const jev: Jev = {
    async systemOne(request) {
      requests.push(request);
      return { model: "jev-test", answers: answers(request), usage: { input_tokens: 10, output_tokens: 1 } };
    },
  };
  return { jev, requests };
}

const labelsOf = (request: SystemOneRequest, head: string) =>
  Object.keys((request.questions[head] as { criteria: Record<string, unknown> }).criteria);

describe("buildRequest", () => {
  test("offers each operation with candidates, the controls, and one target head for each operation", () => {
    const { request, operations } = buildRequest(page, "Send a billing message", []);
    expect(operations).toEqual(["TYPE_TEXT", "CLICK", "SELECT", "WAIT", "SCROLL_DOWN", "DONE", "BLOCKED"]);
    expect(Object.keys(request.questions)).toEqual(["operation", "TYPE_TEXT_target", "CLICK_target", "SELECT_target"]);
    expect(labelsOf(request, "TYPE_TEXT_target")).toEqual(["1", "2"]);
    expect(labelsOf(request, "CLICK_target")).toEqual(["3", "5"]);
    expect(labelsOf(request, "SELECT_target")).toEqual(["4:1", "4:2"]);
  });

  test("offers SCROLL_UP only when the page is scrolled", () => {
    const { operations } = buildRequest({ ...page, scroll: { y: 400, max: 400 } }, "x", []);
    expect(operations).toContain("SCROLL_UP");
    expect(operations).not.toContain("SCROLL_DOWN");
  });

  test("keeps only the last 10 actions", () => {
    const history = Array.from({ length: 15 }, (_, i) => ({ operation: "WAIT" as const, text: String(i), pageChanged: false }));
    const { request } = buildRequest(page, "x", history);
    const recent = (request.state as { recent_actions: { text: string }[] }).recent_actions;
    expect(recent.map((a) => a.text)).toEqual(["5", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
  });
});

describe("decide", () => {
  test("uses the target head for the chosen operation and ignores the others", async () => {
    const { jev } = stubJev((request) => ({
      operation: choiceAnswer("SELECT", labelsOf(request, "operation")),
      SELECT_target: choiceAnswer("4:2", labelsOf(request, "SELECT_target"), 0.8),
      CLICK_target: { choice: "not offered", confidence: Number.NaN, probabilities: {} },
    }));
    const decision = await decide(jev, page, "Choose billing", []);
    expect(decision.operation).toBe("SELECT");
    if (decision.operation !== "SELECT") throw new Error("unreachable");
    expect(decision.target.element.index).toBe(4);
    expect(decision.target.option).toEqual({ value: "billing", label: "Billing" });
    expect(decision.confidence).toBe(0.8);
  });

  test("a control operation needs no target", async () => {
    const { jev } = stubJev((request) => ({ operation: choiceAnswer("DONE", labelsOf(request, "operation")) }));
    const decision = await decide(jev, page, "x", []);
    expect(decision).toMatchObject({ operation: "DONE", confidence: 0.9, model: "jev-test" });
  });

  test("rejects a choice that was not offered", async () => {
    const { jev } = stubJev(() => ({ operation: { choice: "HACK", confidence: 1, probabilities: { HACK: 1 } } }));
    await expect(decide(jev, page, "x", [])).rejects.toThrow(/operation is not valid/);
  });

  test("rejects a probability that is not finite", async () => {
    const { jev } = stubJev((request) => ({
      operation: choiceAnswer("CLICK", labelsOf(request, "operation")),
      CLICK_target: { ...choiceAnswer("5", labelsOf(request, "CLICK_target")), confidence: Number.POSITIVE_INFINITY },
    }));
    await expect(decide(jev, page, "x", [])).rejects.toThrow(/CLICK_target is not valid/);
  });

  test("never sends a password value", async () => {
    const { jev, requests } = stubJev((request) => ({ operation: choiceAnswer("WAIT", labelsOf(request, "operation")) }));
    await decide(jev, { ...page, elements: [{ ...page.elements[1]!, value: "hunter2" }] }, "x", []);
    expect(JSON.stringify(requests[0])).not.toContain("hunter2");
  });
});
