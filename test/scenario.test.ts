import { describe, expect, test } from "vitest";
import { resolveScenarioData, type Scenario } from "../src/scenario.ts";

const scenario: Scenario = {
  name: "References", url: "https://example.test", steps: [{ intent: "Enter values", actionLimit: 3,
    data: { password: "@env:QA_PASSWORD", literal: "Hello @env:NAME" } }],
};

describe("resolveScenarioData", () => {
  test("resolves exact references without modifying the scenario or interpolating text", () => {
    const result = resolveScenarioData(scenario, { QA_PASSWORD: "secret", NAME: "Ada" });
    expect(result.scenario.steps[0]!.data).toEqual({ password: "secret", literal: "Hello @env:NAME" });
    expect(result.secrets).toEqual(["secret"]);
    expect(scenario.steps[0]!.data!.password).toBe("@env:QA_PASSWORD");
  });

  test("allows empty values and does not resolve a returned value twice", () => {
    expect(resolveScenarioData(scenario, { QA_PASSWORD: "" }).secrets).toEqual([""]);
    expect(resolveScenarioData(scenario, { QA_PASSWORD: "@env:OTHER" }).scenario.steps[0]!.data!.password).toBe("@env:OTHER");
  });

  test("rejects missing variables without including other environment values", () => {
    expect(() => resolveScenarioData(scenario, { OTHER: "private" })).toThrow("Missing environment variable: QA_PASSWORD");
  });

  test.each(["@env:", "@env:BAD-NAME", "@env:1BAD", "@env:NAME extra", "@env:NAME\n"])("rejects malformed references: %s", (value) => {
    expect(() => resolveScenarioData({ ...scenario, steps: [{ ...scenario.steps[0]!, data: { value } }] }, {})).toThrow("Invalid environment reference");
  });
});
