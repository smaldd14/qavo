import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { chromium } from "playwright-core";
import { blockOtherHosts } from "./browser/act.ts";
import { createRunDir, writeReport } from "./report.ts";
import { runScenario } from "./run.ts";
import { Config, Scenario } from "./scenario.ts";
import { textModelFromEnv } from "./values.ts";

const USAGE = `Usage:
  qavo run <scenario.json> [--headed] [--config qavo.config.ts] [--storage-state .qavo/role.json]
  qavo login <url> --out .qavo/<role>.json`;

const CONFIG_NAMES = ["qavo.config.ts", "qavo.config.js"];

/** Finds qavo.config.ts in the scenario's folder or a parent folder. */
function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const found = CONFIG_NAMES.map((name) => join(dir, name)).find(existsSync);
    if (found) return found;
    if (dirname(dir) === dir) return undefined;
  }
}

async function run(scenarioPath: string, options: { headed?: boolean; config?: string; storageState?: string }) {
  const scenario = Scenario.parse(JSON.parse(await readFile(scenarioPath, "utf8")));
  const configPath = options.config ? resolve(options.config) : findConfig(dirname(scenarioPath));
  const config = Config.parse(configPath ? (await import(pathToFileURL(configPath).href)).default : {});
  const baseDir = configPath ? dirname(configPath) : process.cwd();
  const url = new URL(scenario.url, config.url).href;
  const allowHosts = config.allowHosts ?? [new URL(url).host];
  const storageState = options.storageState ?? (config.storageState && resolve(baseDir, config.storageState));
  if (storageState && !existsSync(storageState)) {
    throw new Error(`The storage state ${storageState} does not exist. Run: qavo login <url> --out ${storageState}`);
  }

  const jev = new TypeSafeClient();
  const { id, dir } = await createRunDir(join(baseDir, ".qavo"));
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState });
    const page = await context.newPage();
    await blockOtherHosts(page, allowHosts);
    const report = await runScenario({
      page,
      jev,
      textModel: textModelFromEnv(process.env),
      scenario,
      url,
      allowHosts,
      limits: config.limits,
      id,
      dir,
    });
    const reportPath = await writeReport(dir, report);
    for (const [i, step] of report.steps.entries()) {
      const expect = step.expect ? ` expect p=${step.expect.probability.toFixed(2)}` : "";
      console.log(`  ${i + 1}. ${step.status.padEnd(7)} ${step.intent} (${step.turns.length} turns, ${step.durationMs} ms${expect})`);
      if (step.reason) console.log(`     ${step.reason}`);
    }
    console.log(`${report.status.toUpperCase()} ${scenario.name} in ${report.durationMs} ms, ${report.usage.jevRequests} Jev requests`);
    console.log(`Report: ${reportPath}`);
    process.exitCode = report.status === "pass" ? 0 : 1;
  } finally {
    await browser.close();
  }
}

async function login(url: string, out: string) {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    await terminal.question("Log in in the browser window. Then press Enter here to save the session. ");
    terminal.close();
    await mkdir(dirname(resolve(out)), { recursive: true });
    await context.storageState({ path: out });
    console.log(`Saved ${out}. Do not commit this file.`);
  } finally {
    await browser.close();
  }
}

if (existsSync(".env")) process.loadEnvFile(".env");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    headed: { type: "boolean" },
    config: { type: "string" },
    "storage-state": { type: "string" },
    out: { type: "string" },
  },
});
const [command, target] = positionals;
if (command === "run" && target) {
  await run(target, { headed: values.headed, config: values.config, storageState: values["storage-state"] });
} else if (command === "login" && target && values.out) {
  await login(target, values.out);
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
