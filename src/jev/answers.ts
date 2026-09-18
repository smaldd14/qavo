import { z } from "zod";
import type { SystemOneRequest, Usage } from "@typesafe-ai/sdk";

/** The part of TypeSafeClient that qavo uses. Tests pass a stub with the same shape. */
export interface Jev {
  systemOne(request: SystemOneRequest): PromiseLike<{ model: string; answers: Record<string, unknown>; usage: Usage }>;
}

const probability = z.number().finite().min(0).max(1);

export interface ChoiceAnswer<L extends string = string> {
  choice: L;
  confidence: number;
  probabilities: Record<L, number>;
}

/** Checks that a choice answer picks one of the offered labels and has a probability for each label. */
export function parseChoice<L extends string>(answer: unknown, labels: readonly L[], question: string): ChoiceAnswer<L> {
  const schema = z
    .object({
      choice: z.enum(labels as [L, ...L[]]),
      confidence: probability,
      probabilities: z.record(z.string(), probability),
    })
    .refine((a) => labels.every((label) => label in a.probabilities), "a probability is missing for an offered label");
  const result = schema.safeParse(answer);
  if (!result.success) throw new Error(`Jev answer for ${question} is not valid: ${z.prettifyError(result.error)}`);
  return result.data as ChoiceAnswer<L>;
}

/** Returns the probability of yes from a noul answer. */
export function parseNoul(answer: unknown, question: string): number {
  const result = z.object({ noul: probability }).safeParse(answer);
  if (!result.success) throw new Error(`Jev answer for ${question} is not valid: ${z.prettifyError(result.error)}`);
  return result.data.noul;
}
