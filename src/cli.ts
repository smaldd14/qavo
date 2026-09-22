import { constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { chromium } from "playwright-core";
import { blockOtherHosts } from "./browser/act.ts";
import { createRunDir, writeReport } from "./report.ts";
import { runScenario } from "./run.ts";
import { Config, resolveScenarioData, Scenario } from "./scenario.ts";
import { askUrl, confirmDrafts } from "./scenario-confirm.ts";
import { readScenarioInput } from "./scenario-input.ts";
import { draftScenarios, normalizeUrl } from "./scenario-new.ts";
import { writeScenarios } from "./scenario-writer.ts";
import { textModelFromEnv } from "./values.ts";
import { parseUploadConfig, uploadRunArtifacts } from "./upload.ts";

const USAGE = `Usage:
  qavo run <scenario.json> [--headed] [--config qavo.config.ts] [--storage-state .qavo/role.json] [--out <directory>]
  qavo login <url> [--out <session.json>]
  qavo scenario new [--url <start url>] [--from <file>] [--out <directory>]

Login defaults to ~/.qavo/sessions/<encoded-host>.json.
The filename uses encodeURIComponent(URL.host), including the port (localhost:3000 becomes localhost%3A3000.json).
Run loads a session only with --storage-state or config storageState.
Session paths expand ~/. Other relative paths use the current directory, or the config directory for config storageState.`;

const CONFIG_NAMES = ["qavo.config.ts", "qavo.config.js"];

/** Finds qavo.config.ts in the scenario's folder or a parent folder. */
function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const found = CONFIG_NAMES.map((name) => join(dir, name)).find(existsSync);
    if (found) return found;
    if (dirname(dir) === dir) return undefined;
  }
}

function resolveSessionPath(path: string, baseDir = process.cwd()) {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(baseDir, path);
}

async function run(scenarioPath: string, options: { headed?: boolean; config?: string; storageState?: string; out?: string }) {
  const upload = parseUploadConfig();
  const scenario = Scenario.parse(JSON.parse(await readFile(scenarioPath, "utf8")));
  resolveScenarioData(scenario);
  const configPath = options.config ? resolve(options.config) : findConfig(dirname(scenarioPath));
  const config = Config.parse(configPath ? (await import(pathToFileURL(configPath).href)).default : {});
  const baseDir = configPath ? dirname(configPath) : process.cwd();
  const url = new URL(scenario.url, config.url).href;
  const allowHosts = config.allowHosts ?? [new URL(url).host];
  const storageState = options.storageState !== undefined
    ? resolveSessionPath(options.storageState)
    : config.storageState !== undefined ? resolveSessionPath(config.storageState, baseDir) : undefined;
  if (storageState && !existsSync(storageState)) {
    throw new Error(`The storage state ${storageState} does not exist. Run: qavo login <url> --out ${storageState}`);
  }

  const jev = new TypeSafeClient();
  const { id, dir } = await createRunDir(options.out ? resolve(options.out) : undefined);
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
    if (upload) {
      try {
        const location = await uploadRunArtifacts(dir, report, upload);
        console.log(`Artifacts: ${location}`);
      } catch {
        console.error(`Artifact upload failed. Local report: ${reportPath}`);
        process.exitCode = 2;
      }
    }
  } finally {
    await browser.close();
  }
}

async function login(url: string, output?: string) {
  const out = output === undefined
    ? join(homedir(), ".qavo", "sessions", `${encodeURIComponent(new URL(url).host)}.json`)
    : resolveSessionPath(output);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    await terminal.question("Log in in the browser window. Then press Enter here to save the session. ");
    terminal.close();
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    if (output === undefined) await chmod(dirname(out), 0o700);
    const state = await context.storageState();
    const file = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(state), "utf8");
    } finally {
      await file.close();
    }
    console.log(`Saved ${out}. Do not commit this file.`);
  } finally {
    await browser.close();
  }
}

async function scenarioNew(options: { from?: string; out?: string; url?: string }) {
  const url = options.url ? normalizeUrl(options.url) : await askStartUrl();
  const stdin = options.from ? undefined : await readPastedInstructions();
  const drafts = draftScenarios(await readScenarioInput({ file: options.from, stdin }), url);
  if (drafts.length === 0) throw new Error("The instructions contain no steps.");
  const terminalInput = options.from ? process.stdin : createReadStream("/dev/tty");
  const terminalOutput = options.from ? process.stdout : createWriteStream("/dev/tty");
  const terminal = createInterface({ input: terminalInput, output: terminalOutput });
  try {
    const confirmed = await confirmDrafts({ drafts, terminal, output: (line) => console.log(line) });
    if (!confirmed) {
      console.log("Cancelled. No scenario files were written.");
      return;
    }
    const paths = await writeScenarios(resolve(options.out ?? process.cwd()), confirmed);
    for (const path of paths) console.log(`Wrote ${path}`);
  } finally {
    terminal.close();
    if (terminalInput !== process.stdin) terminalInput.destroy();
    if (terminalOutput !== process.stdout) terminalOutput.destroy();
  }
}

async function askStartUrl() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await askUrl(terminal, (line) => console.log(line));
  } finally {
    terminal.close();
  }
}

async function readPastedInstructions() {
  console.log(`Paste instructions. Type .qavo-end on its own line when finished (Ctrl-D also works on an empty line).
Each list item ("1." or "-") is a step. "Expected: ..." on the next line is that step's check. "# Name" starts another scenario.
Text with no list is one step.`);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    for await (const line of input) {
      if (line.trim() === ".qavo-end") break;
      lines.push(line);
    }
  } finally {
    input.close();
  }
  return lines.join("\n");
}

if (existsSync(".env")) process.loadEnvFile(".env");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    headed: { type: "boolean" },
    config: { type: "string" },
    "storage-state": { type: "string" },
    out: { type: "string" },
    from: { type: "string" },
    url: { type: "string" },
  },
});
const [command, target] = positionals;
if (command === "run" && target) {
  await run(target, { headed: values.headed, config: values.config, storageState: values["storage-state"], out: values.out });
} else if (command === "login" && target) {
  await login(target, values.out);
} else if (command === "scenario" && target === "new") {
  try {
    await scenarioNew({ from: values.from, out: values.out, url: values.url });
  } catch (error) {
    console.error(`Scenario creation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
