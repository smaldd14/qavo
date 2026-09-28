import { resolve } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { loadConfig, storageStatePath } from "../config.ts";
import { call, doctor, OPTIONS_ENV, START_ERROR, startDriver, stopDriver } from "./client.ts";
import { DriverError, DriverOptions, driverPaths, type DriverPaths, type Request } from "./protocol.ts";

type Args = { positionals: string[]; values: Record<string, string | boolean | string[] | undefined>; paths: DriverPaths };

interface Command {
  usage: string;
  summary: string;
  details: string;
  examples: string[];
  options?: ParseArgsOptionsConfig;
  positionals: [min: number, max: number];
  run(args: Args): Promise<object>;
}

const TARGET_OPTIONS: ParseArgsOptionsConfig = { fp: { type: "string" }, "dry-run": { type: "boolean" } };
const TARGET_DETAILS = `<index> is an element index from the last snapshot. The driver checks the guards first: the page still has the
fingerprint of your last snapshot (or --fp), and the element is connected, visible, enabled, not covered, and stays in allowHosts.
A refused action does nothing and returns { ok: false, error: { code: "refused", reason, hint } }.
--dry-run runs the guards and names the target, with no input.
The result has the new url, title, fingerprint, pageChanged, and the page text lines that changed.`;

const ask = (paths: DriverPaths, request: Request) => call(paths, request).then((reply) => {
  if (!reply.ok) throw new DriverError(reply.error.code, reply.error.message, reply.error.hint, reply.error);
  const { ok: _ok, ...rest } = reply;
  return rest;
});

function parseIndex(value: string | undefined) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) {
    throw new DriverError("usage", `"${value}" is not an element index.`, "Use the `index` of an element from `qavo browser snapshot`, for example `qavo browser click 7`.");
  }
  return index;
}

const target = (args: Args) => ({
  index: parseIndex(args.positionals[0]),
  ...(typeof args.values.fp === "string" && { fingerprint: args.values.fp }),
  dryRun: args.values["dry-run"] === true,
});

const COMMANDS: Record<string, Command> = {
  start: {
    usage: "start [url] [--headed] [--allow-host <host>]... [--storage-state <file>] [--config <file>] [--idle-minutes <n>]",
    summary: "Start a driver: a browser that stays open between commands.",
    details: `Opens [url] in a new browser and waits until the driver answers. [url] can be a path such as /settings
when qavo.config.ts (found from the current directory) has a url. Without [url], uses the config url.
allowHosts come from the config, else the host of [url]; --allow-host adds more. Navigation to other hosts is blocked.
--storage-state loads a session saved by \`qavo login\` (config storageState also works).
The driver stops after --idle-minutes with no command (default 30).`,
    examples: ["qavo browser start http://localhost:5173", "qavo browser start /work-orders --storage-state ~/.qavo/sessions/localhost%3A5173.json", "qavo browser start http://localhost:5173 --name review-42 --headed"],
    options: {
      headed: { type: "boolean" },
      "allow-host": { type: "string", multiple: true },
      "storage-state": { type: "string" },
      config: { type: "string" },
      "idle-minutes": { type: "string" },
    },
    positionals: [0, 1],
    async run({ positionals, values, paths }) {
      const { config, baseDir } = await loadConfig(values.config as string | undefined, process.cwd());
      const raw = positionals[0] ?? config.url;
      if (!raw) throw new DriverError("usage", "No URL to open.", "Pass a URL, for example `qavo browser start http://localhost:5173`, or set url in qavo.config.ts.");
      const url = URL.parse(raw, config.url)?.href;
      if (!url) throw new DriverError("usage", `"${raw}" is not a URL.`, "Pass an absolute URL such as http://localhost:5173, or a path with a config url.");
      const idleMinutes = Number(values["idle-minutes"] ?? 30);
      if (!(idleMinutes > 0)) throw new DriverError("usage", "--idle-minutes must be a positive number.");
      let storageState: string | undefined;
      try {
        storageState = storageStatePath(values["storage-state"] as string | undefined, config, baseDir);
      } catch (error) {
        throw new DriverError("no_storage_state", (error as Error).message, "Run `qavo login <url>` to save a session, or leave out --storage-state.");
      }
      const allowHosts = [...new Set([...(config.allowHosts ?? [new URL(url).host]), ...((values["allow-host"] as string[] | undefined) ?? [])])];
      const options = DriverOptions.parse({ url, headed: values.headed === true, storageState, allowHosts, idleMinutes });
      const { ok: _ok, ...status } = await startDriver(paths, options);
      return status;
    },
  },
  stop: {
    usage: "stop [--dry-run]",
    summary: "Close the driver's browser and remove its socket.",
    details: "Also cleans up a driver that crashed or stopped answering. --dry-run reports what would be stopped and removed.",
    examples: ["qavo browser stop", "qavo browser stop --name review-42 --dry-run"],
    options: { "dry-run": { type: "boolean" } },
    positionals: [0, 0],
    run: ({ values, paths }) => stopDriver(paths, values["dry-run"] === true),
  },
  status: {
    usage: "status",
    summary: "Show the driver's page, allowHosts, and process.",
    details: "Fails with not_running when no driver answers.",
    examples: ["qavo browser status"],
    positionals: [0, 0],
    run: ({ paths }) => ask(paths, { command: "status" }),
  },
  doctor: {
    usage: "doctor",
    summary: "Check Node, Chromium, and the driver. Each failed check has a fix.",
    details: "Run it first when anything looks wrong. It works when no driver is running.",
    examples: ["qavo browser doctor"],
    positionals: [0, 0],
    run: ({ paths }) => doctor(paths),
  },
  open: {
    usage: "open <url>",
    summary: "Navigate to a URL or a path, then wait until the page settles.",
    details: "A path resolves against the current page. Hosts outside allowHosts are refused.",
    examples: ["qavo browser open /settings", "qavo browser open http://localhost:5173/work-orders?status=open"],
    positionals: [1, 1],
    run: ({ positionals, paths }) => ask(paths, { command: "open", url: positionals[0]! }),
  },
  snapshot: {
    usage: "snapshot",
    summary: "Read the settled page: url, title, visible text, elements with indices, and the fingerprint.",
    details: `Waits until no fetch or XHR is open and the page has not changed for 250 ms (5 s at most).
Each element has an index, role, name, value, state (checked, selected, expanded, pressed), context, and the
operations it allows (CLICK, TYPE_TEXT, SELECT with options). Password values are never included.
Actions use these indices. An index stays the same for the same element until the page reloads.`,
    examples: ["qavo browser snapshot"],
    positionals: [0, 0],
    run: ({ paths }) => ask(paths, { command: "snapshot" }),
  },
  click: {
    usage: "click <index> [--fp <fingerprint>] [--dry-run]",
    summary: "Click an element by snapshot index.",
    details: TARGET_DETAILS,
    examples: ["qavo browser click 7", "qavo browser click 7 --dry-run"],
    options: TARGET_OPTIONS,
    positionals: [1, 1],
    run: (args) => ask(args.paths, { command: "click", ...target(args) }),
  },
  type: {
    usage: "type <index> <text> | type <index> --env <NAME>   [--fp <fingerprint>] [--dry-run]",
    summary: "Replace the text in an editable element.",
    details: `${TARGET_DETAILS}
The output never echoes the text. A password field accepts text only from --env: the value of that environment
variable (from the shell or .env), so that the secret never passes through your context.`,
    examples: ["qavo browser type 4 \"Ada Lovelace\"", "qavo browser type 5 --env QA_PASSWORD", "qavo browser type 4 \"\"   # clear the field"],
    options: { ...TARGET_OPTIONS, env: { type: "string" } },
    positionals: [1, 2],
    run(args) {
      const name = args.values.env as string | undefined;
      const literal = args.positionals[1];
      if ((name === undefined) === (literal === undefined)) {
        throw new DriverError("usage", "Pass either <text> or --env <NAME>, not both.", "Example: `qavo browser type 4 \"Ada\"` or `qavo browser type 5 --env QA_PASSWORD`.");
      }
      let text = literal;
      if (name !== undefined) {
        text = process.env[name];
        if (text === undefined) throw new DriverError("missing_env", `The environment variable ${name} is not set.`, `Set ${name} in the shell or in .env in the current directory.`);
      }
      return ask(args.paths, { command: "type", ...target(args), text: text!, ...(name !== undefined && { env: name }) });
    },
  },
  select: {
    usage: "select <index> <value> [--fp <fingerprint>] [--dry-run]",
    summary: "Choose an option in a native <select> by option value.",
    details: `${TARGET_DETAILS}\nUse the option \`value\` from the snapshot, not its label. For a custom listbox, click it, then click the option.`,
    examples: ["qavo browser select 9 billing"],
    options: TARGET_OPTIONS,
    positionals: [2, 2],
    run: (args) => ask(args.paths, { command: "select", ...target(args), value: args.positionals[1]! }),
  },
  press: {
    usage: "press <key>",
    summary: "Press a key or chord on the focused element, then wait until the page settles.",
    details: "Uses Playwright key names. ControlOrMeta is Meta on macOS and Control elsewhere.",
    examples: ["qavo browser press Enter", "qavo browser press Escape", "qavo browser press ControlOrMeta+KeyK"],
    positionals: [1, 1],
    run: ({ positionals, paths }) => ask(paths, { command: "press", key: positionals[0]! }),
  },
  scroll: {
    usage: "scroll <up|down>",
    summary: "Scroll the page by most of one screen.",
    details: "Elements below the fold are already in the snapshot. Scroll to load more content or to see it in a screenshot.",
    examples: ["qavo browser scroll down"],
    positionals: [1, 1],
    run({ positionals, paths }) {
      const direction = positionals[0];
      if (direction !== "up" && direction !== "down") throw new DriverError("usage", `"${direction}" is not a direction.`, "Use `qavo browser scroll down` or `qavo browser scroll up`.");
      return ask(paths, { command: "scroll", direction });
    },
  },
  "wait-settle": {
    usage: "wait-settle",
    summary: "Wait until no fetch or XHR is open and the page stops changing (5 s at most).",
    details: "Use it instead of a fixed sleep after an action that starts slow work. Returns a short summary, not the full snapshot.",
    examples: ["qavo browser wait-settle"],
    positionals: [0, 0],
    run: ({ paths }) => ask(paths, { command: "wait-settle" }),
  },
  screenshot: {
    usage: "screenshot [path] [--full-page]",
    summary: "Save a PNG of the page as evidence.",
    details: "Without [path], saves under the driver's screenshots directory. The result has the absolute path.",
    examples: ["qavo browser screenshot", "qavo browser screenshot /tmp/after-save.png --full-page"],
    options: { "full-page": { type: "boolean" } },
    positionals: [0, 1],
    run: ({ positionals, values, paths }) =>
      ask(paths, { command: "screenshot", ...(positionals[0] && { path: resolve(positionals[0]) }), fullPage: values["full-page"] === true }),
  },
};

const OVERVIEW = `qavo browser: drive a real browser from a coding agent, one command at a time. No model runs inside.

Usage: qavo browser <command> [arguments] [--name <driver>]

Start a driver, read the page, act by element index, and keep evidence:
  qavo browser start http://localhost:5173
  qavo browser snapshot                 # elements with indices, text, fingerprint
  qavo browser type 4 "Ada Lovelace"
  qavo browser click 7                  # result shows what changed on the page
  qavo browser screenshot /tmp/proof.png
  qavo browser stop

Commands:
${Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(12)} ${command.summary}`).join("\n")}

Every command prints one JSON object. Success: { "ok": true, ... }. Failure: { "ok": false, "error": { code, message, hint } }
with exit code 1; the hint says what to run instead.
--name <driver> (or QAVO_DRIVER) picks a driver, default "default". Use one name for each checkout or task.
Run \`qavo browser <command> --help\` for details and examples.`;

const helpFor = (name: string, command: Command) => `Usage: qavo browser ${command.usage} [--name <driver>]

${command.summary}

${command.details}

Examples:
${command.examples.map((example) => `  ${example}`).join("\n")}`;

/** Runs `qavo browser <argv>`. Prints JSON (or help text) and returns the exit code. */
export async function browserCommand(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "serve") return serve(rest);
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    console.log(OVERVIEW);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  try {
    if (!command) {
      throw new DriverError("unknown_command", `"${name}" is not a qavo browser command.`, `Commands: ${Object.keys(COMMANDS).join(", ")}. Run \`qavo browser --help\`.`);
    }
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...command.options, name: { type: "string" }, help: { type: "boolean", short: "h" } },
      });
    } catch (error) {
      throw new DriverError("usage", (error as Error).message, `Run \`qavo browser ${name} --help\`.`);
    }
    if (parsed.values.help) {
      console.log(helpFor(name, command));
      return 0;
    }
    const [min, max] = command.positionals;
    if (parsed.positionals.length < min || parsed.positionals.length > max) {
      throw new DriverError("usage", `Usage: qavo browser ${command.usage}`, `Run \`qavo browser ${name} --help\` for examples.`);
    }
    const paths = driverPaths((parsed.values.name as string | undefined) ?? process.env.QAVO_DRIVER ?? "default");
    const result = await command.run({ positionals: parsed.positionals, values: parsed.values, paths });
    console.log(JSON.stringify({ ok: true, ...result }));
    return 0;
  } catch (error) {
    const driverError = error instanceof DriverError ? error : new DriverError("error", error instanceof Error ? error.message : String(error), "Run `qavo browser doctor`.");
    console.log(JSON.stringify({ ok: false, error: driverError }));
    return 1;
  }
}

/** The driver process itself. `qavo browser start` spawns it; it is not for direct use. */
async function serve(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { name: { type: "string" } } });
  const options = DriverOptions.parse(JSON.parse(process.env[OPTIONS_ENV] ?? "null"));
  delete process.env[OPTIONS_ENV];
  const { serveDriver } = await import("./daemon.ts");
  try {
    await serveDriver(driverPaths(values.name ?? "default"), options);
    return 0;
  } catch (error) {
    // The last log line is the error that `start` prints.
    const driverError = error instanceof DriverError ? error : new DriverError("start_failed", error instanceof Error ? error.message.split("\n")[0]! : String(error));
    console.error(`${START_ERROR}${JSON.stringify(driverError)}`);
    return 1;
  }
}
