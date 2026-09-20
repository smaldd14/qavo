import { choice, type Usage } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { Element, Snapshot } from "./browser/snapshot.ts";
import { parseChoice, type ChoiceAnswer, type Jev } from "./jev/answers.ts";
import { HISTORY_LIMIT, type HistoryEntry } from "./jev/decide.ts";
import { DATA_KEY_RULES, TEXT_VALUE_RULES } from "./jev/prompts.ts";
import type { Step } from "./scenario.ts";

interface TextModelContext {
  step: string;
  field: { name: string; role: string; value?: string; context?: string };
  page: { title: string; text: string };
  recent_actions: HistoryEntry[];
}

/** Writes a value for a field. Returns null when the model cannot know the value. */
export type TextModel = (context: TextModelContext) => Promise<{ text: string | null; model: string; usage?: TextUsage }>;

export interface TextUsage {
  inputTokens: number;
  outputTokens: number;
}

export type Value =
  | { text: string; source: "data"; key: string; answer: ChoiceAnswer; usage: Usage; latencyMs: number }
  | { text: string; source: "model"; model: string; answer?: ChoiceAnswer; usage?: TextUsage; latencyMs: number };

/** No value can be typed. The step stops as `blocked` with this reason. */
export class NoValue extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoValue";
  }
}

const NONE = "none";

/**
 * Finds the text for a TYPE_TEXT action.
 * Jev chooses a key from `step.data` (only key names are sent, never values). With no key, the text model
 * writes the value. A password field takes its value only from `step.data` and never reaches a model.
 */
export async function valueFor(input: {
  jev: Jev;
  textModel?: TextModel;
  step: Step;
  element: Element;
  page: Snapshot;
  history: HistoryEntry[];
  onUsage?: (event: { source: "jev"; usage: Usage } | { source: "model"; usage?: TextUsage }) => void;
}): Promise<Value> {
  const { jev, textModel, step, element, page, history, onUsage } = input;
  const keys = Object.keys(step.data ?? {});
  let answer: ChoiceAnswer | undefined;
  const started = performance.now();

  if (keys.length > 0) {
    const labels = [...keys, NONE];
    const result = await jev.systemOne({
      state: {
        step: step.intent,
        field: { name: element.name, role: element.role, ...(element.context && { context: element.context }) },
        data: keys,
      },
      questions: {
        data_key: choice(
          { rules: DATA_KEY_RULES },
          Object.fromEntries(labels.map((key) => [key, key === NONE ? "No key fits this field." : `The value of data key "${key}".`])),
        ),
      },
    });
    onUsage?.({ source: "jev", usage: result.usage });
    answer = parseChoice(result.answers.data_key, labels, "data_key");
    if (answer.choice !== NONE) {
      const latencyMs = Math.round(performance.now() - started);
      return { text: step.data![answer.choice]!, source: "data", key: answer.choice, answer, usage: result.usage, latencyMs };
    }
  }

  if (element.sensitive) throw new NoValue(`The field "${element.name}" is a password field, and step.data has no value for it.`);
  if (!textModel) throw new NoValue(`No step.data key fits "${element.name}", and no text model is configured.`);
  const generated = await textModel({
    step: step.intent,
    field: {
      name: element.name,
      role: element.role,
      ...(element.value !== undefined && { value: element.value }),
      ...(element.context && { context: element.context }),
    },
    page: { title: page.title, text: page.text },
    recent_actions: history.slice(-HISTORY_LIMIT),
  });
  onUsage?.({ source: "model", usage: generated.usage });
  if (generated.text === null) throw new NoValue(`The text model has no value for "${element.name}".`);
  const latencyMs = Math.round(performance.now() - started);
  return { text: generated.text, source: "model", model: generated.model, answer, usage: generated.usage, latencyMs };
}

const TextOutput = z.object({ text: z.string().min(1).max(2000).nullable() }).strict();
const ChatCompletion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }).transform((usage): TextUsage => ({ inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens })).optional(),
});

/** An OpenAI-compatible chat model that returns JSON `{ text }`. Returns undefined when no key is set. */
export function textModelFromEnv(env: NodeJS.ProcessEnv): TextModel | undefined {
  const key = env.TEXT_MODEL_API_KEY;
  if (!key) return undefined;
  const baseUrl = (env.TEXT_MODEL_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env.TEXT_MODEL || "gpt-5-nano";
  return async (context) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: TEXT_VALUE_RULES },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`The text model returned HTTP ${response.status}.`);
    const completion = ChatCompletion.parse(await response.json());
    const output = TextOutput.parse(JSON.parse(completion.choices[0]!.message.content));
    return { text: output.text, model, usage: completion.usage };
  };
}
