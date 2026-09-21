import { z } from "zod";

export const Step = z.object({
  intent: z.string().min(1),
  data: z.record(z.string(), z.string()).optional(),
  expect: z.string().min(1).optional(),
  actionLimit: z.number().int().positive().default(20),
});
export type Step = z.infer<typeof Step>;

export const Scenario = z.object({
  name: z.string().min(1),
  /** An absolute URL, or a path that resolves against `url` in qavo.config.ts. */
  url: z.string().min(1),
  steps: z.array(Step).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

export function resolveScenarioData(scenario: Scenario, env: NodeJS.ProcessEnv = process.env) {
  const secrets: string[] = [];
  const steps = scenario.steps.map((step) => ({
    ...step,
    ...(step.data && { data: Object.fromEntries(Object.entries(step.data).map(([key, value]) => {
      if (!value.startsWith("@env:")) return [key, value];
      if (!/^@env:[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.includes("\n")) {
        throw new Error("Invalid environment reference in step.data.");
      }
      const name = value.slice(5);
      const resolved = Object.hasOwn(env, name) ? env[name] : undefined;
      if (resolved === undefined) throw new Error(`Missing environment variable: ${name}`);
      secrets.push(resolved);
      return [key, resolved];
    })) }),
  }));
  return { scenario: { ...scenario, steps }, secrets: [...new Set(secrets)] };
}

export const Limits = z.object({
  /** A decision with a lower confidence stops the run as `unclear`. */
  confidence: z.number().min(0).max(1).default(0.5),
  /** The `expect` check passes at or above this probability of yes. */
  expectPass: z.number().min(0).max(1).default(0.7),
  /** The `expect` check fails at or below this probability of yes. Between the two, the result is `unclear`. */
  expectFail: z.number().min(0).max(1).default(0.3),
  stepSeconds: z.number().positive().default(120),
  /** Refusals in a row, or actions in a row that do not change the page, that stop a step as `blocked`. */
  stuckActions: z.number().int().positive().default(3),
});
export type Limits = z.infer<typeof Limits>;

/** The default export of qavo.config.ts. */
export const Config = z.object({
  url: z.url().optional(),
  storageState: z.string().optional(),
  allowHosts: z.array(z.string()).optional(),
  limits: Limits.default(Limits.parse({})),
});
export type Config = z.infer<typeof Config>;
