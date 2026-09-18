import { choice, type Usage } from "@typesafe-ai/sdk";
import type { Element, Operation, Snapshot } from "../browser/snapshot.ts";
import { parseChoice, type ChoiceAnswer, type Jev } from "./answers.ts";
import { OPERATION_RULES, TARGET_RULES } from "./prompts.ts";

export type Control = "WAIT" | "SCROLL_DOWN" | "SCROLL_UP" | "DONE" | "BLOCKED";

/** One executed action, as Jev sees it in the recent actions. */
export interface HistoryEntry {
  operation: Operation | Control;
  element?: string;
  text?: string;
  pageChanged: boolean | null;
}

export interface Target {
  label: string;
  element: Element;
  option?: { value: string; label: string };
}

export type Decision = {
  confidence: number;
  answers: { operation: ChoiceAnswer; target?: ChoiceAnswer };
  model: string;
  usage: Usage;
  latencyMs: number;
} & ({ operation: Operation; target: Target } | { operation: Control });

const OPERATION_DESCRIPTIONS: Record<Operation | Control, string> = {
  CLICK: "Click a button, link, tab, checkbox, menu item, or suggestion.",
  TYPE_TEXT: "Enter or replace the text in an editable field. Another step supplies the text.",
  SELECT: "Select an option in a dropdown.",
  WAIT: "Wait for the page to update.",
  SCROLL_DOWN: "Scroll down to see more of the page.",
  SCROLL_UP: "Scroll up to see more of the page.",
  DONE: "The step is visibly complete.",
  BLOCKED: "No offered operation can make progress on the step.",
};

const HISTORY_LIMIT = 10;

/** Offered target labels for each operation. SELECT targets are `<index>:<option position>`. */
function targetsFor(elements: Element[]): Partial<Record<Operation, Target[]>> {
  const targets: Partial<Record<Operation, Target[]>> = {};
  for (const element of elements) {
    for (const operation of element.operations) {
      const list = (targets[operation] ??= []);
      if (operation === "SELECT") {
        element.options?.forEach((option, i) => list.push({ label: `${element.index}:${i + 1}`, element, option }));
      } else {
        list.push({ label: String(element.index), element });
      }
    }
  }
  return targets;
}

const describeElement = (e: Element) => ({
  element: `[${e.index}] ${e.name}`,
  role: e.role,
  ...(e.value !== undefined && !e.sensitive && { value: e.value }),
  ...(e.sensitive && { sensitive: true }),
  ...(e.checked !== undefined && { checked: e.checked }),
  ...(e.selected !== undefined && { selected: e.selected }),
  ...(e.expanded !== undefined && { expanded: e.expanded }),
  ...(e.pressed !== undefined && { pressed: e.pressed }),
  ...(e.context && { context: e.context }),
});

export function buildRequest(page: Snapshot, intent: string, history: HistoryEntry[]) {
  const targets = targetsFor(page.elements);
  const operations: (Operation | Control)[] = [
    ...(Object.keys(targets) as Operation[]),
    "WAIT",
    ...(page.scroll.y < page.scroll.max ? (["SCROLL_DOWN"] as const) : []),
    ...(page.scroll.y > 0 ? (["SCROLL_UP"] as const) : []),
    "DONE",
    "BLOCKED",
  ];
  const questions: Record<string, ReturnType<typeof choice>> = {
    operation: choice(
      { step: intent, rules: OPERATION_RULES },
      Object.fromEntries(operations.map((op) => [op, OPERATION_DESCRIPTIONS[op]])),
    ),
  };
  for (const [operation, list] of Object.entries(targets)) {
    questions[`${operation}_target`] = choice(
      { step: intent, operation, rules: TARGET_RULES },
      Object.fromEntries(
        list.map((t) => [
          t.label,
          t.option ? { ...describeElement(t.element), element: `[${t.label}] ${t.element.name} → ${t.option.label}` } : describeElement(t.element),
        ]),
      ),
    );
  }
  const state = {
    page: { url: page.url, title: page.title, text: page.text },
    elements: page.elements.map((e) => ({
      ...describeElement(e),
      operations: e.operations,
      ...(e.options && { options: e.options.map((o, i) => `${e.index}:${i + 1} ${o.label}`) }),
    })),
    recent_actions: history.slice(-HISTORY_LIMIT).map((h) => ({
      operation: h.operation,
      ...(h.element && { element: h.element }),
      ...(h.text !== undefined && { text: h.text }),
      page_changed: h.pageChanged,
    })),
  };
  return { request: { state, questions }, operations, targets };
}

/** One Jev request: the operation, and a target for each operation. Only the chosen operation's target is used. */
export async function decide(jev: Jev, page: Snapshot, intent: string, history: HistoryEntry[]): Promise<Decision> {
  const { request, operations, targets } = buildRequest(page, intent, history);
  const started = performance.now();
  const result = await jev.systemOne(request);
  const latencyMs = Math.round(performance.now() - started);
  const operationAnswer = parseChoice(result.answers.operation, operations, "operation");
  const operation = operationAnswer.choice;
  const common = { confidence: operationAnswer.confidence, model: result.model, usage: result.usage, latencyMs };
  if (operation !== "CLICK" && operation !== "TYPE_TEXT" && operation !== "SELECT") {
    return { ...common, operation, answers: { operation: operationAnswer } };
  }
  const offered = targets[operation] ?? [];
  const head = `${operation}_target`;
  const targetAnswer = parseChoice(result.answers[head], offered.map((t) => t.label), head);
  const target = offered.find((t) => t.label === targetAnswer.choice)!;
  return {
    ...common,
    confidence: Math.min(operationAnswer.confidence, targetAnswer.confidence),
    operation,
    target,
    answers: { operation: operationAnswer, target: targetAnswer },
  };
}
