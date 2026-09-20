import { afterEach, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "../src/browser/snapshot.ts";
import type { Jev } from "../src/jev/answers.ts";
import { valueFor, textModelFromEnv, NoValue, type TextModel } from "../src/values.ts";

const page: Snapshot = {
  url: "http://127.0.0.1/form.html",
  title: "Contact form",
  text: "Contact us",
  elements: [],
  fingerprint: "test",
  omitted: 0,
  scroll: { y: 0, max: 0 },
};
const element = { index: 1, role: "textbox", name: "Message", operations: ["TYPE_TEXT" as const] };
const step = { intent: "Write a message", data: { message: "Hello" }, actionLimit: 3 };
const usage = { input_tokens: 10, output_tokens: 1 };
const modelUsage = { inputTokens: 20, outputTokens: 5 };

function jevFor(choice: string): Jev {
  return {
    async systemOne() {
      return {
        model: "fake",
        usage,
        answers: { data_key: { choice, confidence: 0.9, probabilities: { message: 0.1, none: 0.9 } } },
      };
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("valueFor", () => {
  test("counts a data choice once and does not call the text model", async () => {
    const onUsage = vi.fn();
    const textModel = vi.fn<TextModel>();
    const value = await valueFor({ jev: jevFor("message"), textModel, page, element, step, history: [], onUsage });
    expect(value).toMatchObject({ text: "Hello", source: "data", usage });
    expect(onUsage.mock.calls).toEqual([[{ source: "jev", usage }]]);
    expect(textModel).not.toHaveBeenCalled();
  });

  test.each(["Generated", null])("counts both calls when Jev chooses none and the text model returns %s", async (text) => {
    const onUsage = vi.fn();
    const textModel = vi.fn<TextModel>(async () => ({ text, model: "fake-text", usage: modelUsage }));
    const result = valueFor({ jev: jevFor("none"), textModel, page, element, step, history: [], onUsage });
    if (text === null) await expect(result).rejects.toThrow(NoValue);
    else await expect(result).resolves.toMatchObject({ text, source: "model", usage: modelUsage, answer: { choice: "none" } });
    expect(onUsage.mock.calls).toEqual([[{ source: "jev", usage }], [{ source: "model", usage: modelUsage }]]);
  });

  test("counts Jev even when no text model is configured", async () => {
    const onUsage = vi.fn();
    await expect(valueFor({ jev: jevFor("none"), page, element, step, history: [], onUsage })).rejects.toThrow(/no text model/);
    expect(onUsage.mock.calls).toEqual([[{ source: "jev", usage }]]);
  });

  test("counts Jev but never sends a sensitive field to the text model", async () => {
    const onUsage = vi.fn();
    const textModel = vi.fn<TextModel>();
    await expect(valueFor({
      jev: jevFor("none"), textModel, page, element: { ...element, sensitive: true, value: "private-value" },
      step, history: [], onUsage,
    })).rejects.toThrow(/password field/);
    expect(onUsage.mock.calls).toEqual([[{ source: "jev", usage }]]);
    expect(textModel).not.toHaveBeenCalled();
  });

  test("counts Jev before it rejects an invalid answer", async () => {
    const onUsage = vi.fn();
    await expect(valueFor({ jev: jevFor("unoffered"), page, element, step, history: [], onUsage })).rejects.toThrow(/not valid/);
    expect(onUsage.mock.calls).toEqual([[{ source: "jev", usage }]]);
  });

  test("uses the same last ten actions for text values as decisions", async () => {
    const history = Array.from({ length: 15 }, (_, i) => ({ operation: "WAIT" as const, text: String(i), pageChanged: false }));
    const textModel = vi.fn<TextModel>(async () => ({ text: "Generated", model: "fake-text" }));
    const onUsage = vi.fn();
    await valueFor({ jev: jevFor("none"), textModel, page, element, step: { intent: step.intent, actionLimit: 3 }, history, onUsage });
    expect(textModel.mock.calls[0]![0].recent_actions).toEqual(history.slice(-10));
    expect(onUsage.mock.calls).toEqual([[{ source: "model", usage: undefined }]]);
  });
});

describe("textModelFromEnv", () => {
  const context = { step: "Write a message", field: { name: "Message", role: "textbox" }, page: { title: "Contact", text: "" }, recent_actions: [] };
  const env = { TEXT_MODEL_API_KEY: "test-key", TEXT_MODEL_BASE_URL: "http://127.0.0.1/v1", TEXT_MODEL: "fake-text" };

  test.each([
    { raw: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }, normalized: modelUsage },
    { raw: { prompt_tokens: 0, completion_tokens: 0 }, normalized: { inputTokens: 0, outputTokens: 0 } },
    { raw: undefined, normalized: undefined },
  ])("normalizes optional usage: $raw", async ({ raw, normalized }) => {
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"text":"Hello"}' } }], usage: raw }));
    vi.stubGlobal("fetch", fetch);
    const model = textModelFromEnv(env)!;
    await expect(model(context)).resolves.toEqual({ text: "Hello", model: "fake-text", usage: normalized });
    expect(fetch).toHaveBeenCalledOnce();
  });

  test.each([
    { prompt_tokens: -1, completion_tokens: 5 },
    { prompt_tokens: "20", completion_tokens: 5 },
    { prompt_tokens: 20, completion_tokens: 1.5 },
    { prompt_tokens: 20 },
    { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 5 },
    null,
  ])("rejects malformed usage: %j", async (usage) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"text":"Hello"}' } }], usage }),
    })));
    await expect(textModelFromEnv(env)!(context)).rejects.toThrow();
  });
});
