// Sends a recorded Jev operation request again and prints the answers, to test a prompt change against real
// decisions. By default the questions use the current rules in src/jev/prompts.ts. --as-recorded sends the
// request exactly as it was recorded.
// Usage: pnpm tsx scripts/replay-turn.ts <report.json> <step> <turn> [--times 3] [--as-recorded]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { TypeSafeClient, type Question } from "@typesafe-ai/sdk";
import { OPERATION_RULES, TARGET_RULES } from "../src/jev/prompts.ts";
import type { RunReport } from "../src/report.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { times: { type: "string", default: "3" }, "as-recorded": { type: "boolean" } },
});
const [reportPath, stepNumber, turnNumber] = positionals;
if (!reportPath || !stepNumber || !turnNumber) throw new Error("Usage: replay-turn.ts <report.json> <step> <turn> [--times 3] [--as-recorded]");
const report: RunReport = JSON.parse(readFileSync(reportPath, "utf8"));
const turn = report.steps[Number(stepNumber) - 1]?.turns[Number(turnNumber) - 1];
if (!turn) throw new Error(`No step ${stepNumber}, turn ${turnNumber} in ${reportPath}`);

const recorded = turn.decision.request;
const withCurrentRules = (name: string, question: Question): Question => ({
  ...question,
  instructions: { ...(question.instructions as object), rules: name === "operation" ? OPERATION_RULES : TARGET_RULES },
});
const request = values["as-recorded"]
  ? recorded
  : { ...recorded, questions: Object.fromEntries(Object.entries(recorded.questions).map(([name, q]) => [name, withCurrentRules(name, q)])) };

console.log(`Recorded: ${turn.decision.operation} ${turn.decision.target?.name ?? ""} (${turn.decision.confidence.toFixed(2)})`);
const jev = new TypeSafeClient();
for (let i = 0; i < Number(values.times); i++) {
  const { answers } = await jev.systemOne(request);
  const operation = answers.operation as { choice: string; confidence: number; probabilities: Record<string, number> };
  const top = Object.entries(operation.probabilities)
    .filter(([, p]) => p >= 0.02)
    .sort(([, a], [, b]) => b - a)
    .map(([label, p]) => `${label}=${p.toFixed(2)}`);
  console.log(`Replay ${i + 1}: ${operation.choice} (${operation.confidence.toFixed(2)}) ${top.join(" ")}`);
}
