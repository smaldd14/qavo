import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";
import { act, blockOtherHosts, checkGuards, isAllowedUrl, Refused, type Action, type RefusalReason } from "../browser/act.ts";
import { PAGE_SCRIPT, settledSnapshot, snapshot, textChanges, trackRequests, type Snapshot } from "../browser/snapshot.ts";
import { observe, type Observer } from "./observe.ts";
import { DriverError, Request, type DriverOptions, type DriverPaths } from "./protocol.ts";

type Target = { index: number; role: string; name: string; sensitive?: true };

const EVAL_TIMEOUT_MS = 10_000;
const EVAL_CHARS = 20_000;
const EVAL_HINT = "Pass one expression, for example `document.title`. For statements, wrap them: `(() => { const rows = document.querySelectorAll('tr'); return rows.length; })()`.";

const RESNAPSHOT = "Run `qavo browser snapshot`, then use the new indices and fingerprint.";
const REFUSAL_HINTS: Record<RefusalReason, string> = {
  stale: `The page changed after your snapshot. ${RESNAPSHOT}`,
  missing: `The element is no longer on the page. ${RESNAPSHOT}`,
  hidden: `The element is hidden. It may be inside a closed menu or tab. ${RESNAPSHOT}`,
  disabled: "The element is disabled. Fill the required fields first, or run `qavo browser wait-settle` if the page is still loading.",
  covered: "Another element covers the target, for example a dialog, a toast, or a sticky header. Close it, or run `qavo browser wait-settle`, then snapshot again.",
  not_editable: "Only textbox, searchbox, spinbutton, and editable combobox elements accept `type`. Use `click` for checkboxes, radios, and switches.",
  option: "Use a `value` from the element's `options` in the snapshot. Disabled options are refused.",
  host: "The link leaves allowHosts. Restart the driver with `--allow-host <host>` if the host is part of the app.",
};

/** Owns one browser page and answers one command at a time on the driver socket until `stop` or the idle limit. */
export async function serveDriver(paths: DriverPaths, options: DriverOptions) {
  const browser = await chromium.launch({ headless: !options.headed });
  let page: Page;
  let observer: Observer;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: options.storageState });
    page = await context.newPage();
    observer = observe(page);
    trackRequests(page);
    await blockOtherHosts(page, options.allowHosts);
    await page.goto(options.url);
  } catch (error) {
    await browser.close();
    throw new DriverError("start_failed", `Could not open ${options.url}: ${messageOf(error)}`, "Check that the app is running at the URL, then start again.");
  }

  const startedAt = new Date().toISOString();
  let last: Snapshot | undefined;
  let lastActionCursor = 0;
  let queue = Promise.resolve();
  let idle: NodeJS.Timeout | undefined;
  let stopping = false;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    server.close();
    await browser.close().catch(() => undefined);
    await rm(paths.socket, { force: true });
    await rm(paths.state, { force: true });
    process.exit(0);
  };
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(shutdown, options.idleMinutes * 60_000);
  };

  const handle = async (request: Request): Promise<object> => {
    switch (request.command) {
      case "status":
        return {
          name: paths.name, pid: process.pid, startedAt, url: page.url(), title: await page.title(),
          allowHosts: options.allowHosts, headed: options.headed, idleMinutes: options.idleMinutes, dir: paths.dir,
        };
      case "stop":
        setImmediate(shutdown);
        return { stopped: paths.name };
      case "open": {
        const url = URL.parse(request.url, page.url())?.href;
        if (!url) throw new DriverError("bad_url", `"${request.url}" is not a URL.`, "Pass an absolute URL, or a path such as /settings after the driver has opened the app.");
        if (!isAllowedUrl(url, options.allowHosts)) {
          throw new DriverError("host_not_allowed", `${new URL(url).host} is not in allowHosts (${options.allowHosts.join(", ")}).`,
            "Restart the driver with `--allow-host <host>` if the host is part of the app.");
        }
        const cursor = lastActionCursor = observer.cursor();
        try {
          await page.goto(url);
        } catch (error) {
          throw new DriverError("navigation_failed", `Could not open ${url}: ${messageOf(error)}`, "Check that the app is running. `qavo browser doctor` shows the driver state.");
        }
        return { ...summary(last = await settledSnapshot(page)), ...observer.activity(cursor) };
      }
      case "snapshot":
        return (last = await settledSnapshot(page));
      case "wait-settle": {
        const started = Date.now();
        last = await settledSnapshot(page);
        return { ...summary(last), waitedMs: Date.now() - started };
      }
      case "click":
        return targeted(request, { operation: "CLICK", index: request.index });
      case "type": {
        const target = await describe(page, request.index);
        if (target?.sensitive && request.env === undefined) {
          throw new DriverError("secret_literal", `Element ${request.index} is a password field. It accepts text only from an environment variable.`,
            `Put the value in an environment variable (or .env), then run \`qavo browser type ${request.index} --env NAME\`.`);
        }
        if (request.env !== undefined) observer.addSecret(request.text);
        const result = await targeted(request, { operation: "TYPE_TEXT", index: request.index, text: request.text });
        return { ...result, typed: { characters: request.text.length, ...(request.env ? { env: request.env } : {}) } };
      }
      case "select":
        return targeted(request, { operation: "SELECT", index: request.index, value: request.value });
      case "press": {
        const before = await snapshot(page);
        const cursor = observer.cursor();
        try {
          await page.keyboard.press(request.key);
        } catch (error) {
          throw new DriverError("bad_key", `Could not press "${request.key}": ${messageOf(error)}`,
            "Use a Playwright key name, for example Enter, Escape, Tab, ArrowDown, Meta+KeyK, or ControlOrMeta+Comma.");
        }
        return afterAction(before, cursor, { key: request.key });
      }
      case "scroll": {
        const before = await snapshot(page);
        const cursor = observer.cursor();
        await act(page, { operation: request.direction === "down" ? "SCROLL_DOWN" : "SCROLL_UP" }, { fingerprint: "", allowHosts: options.allowHosts });
        return afterAction(before, cursor, { direction: request.direction });
      }
      case "screenshot": {
        const path = request.path ?? join(paths.screenshots, `${new Date().toISOString().replaceAll(":", "-")}.png`);
        if (!isAbsolute(path)) throw new DriverError("bad_path", "The screenshot path must be absolute.");
        await mkdir(dirname(path), { recursive: true });
        await page.screenshot({ path, fullPage: request.fullPage });
        return { path, url: page.url() };
      }
      case "network": {
        if (request.id !== undefined) {
          const detail = await observer.requestDetail(request.id);
          if (!detail) {
            throw new DriverError("not_found", `No recorded request has id ${request.id}.`,
              "Run `qavo browser network` to list the recorded requests and their ids. The driver keeps the last 500.");
          }
          return { request: detail };
        }
        return observer.listRequests({ since: sinceOf(request), failed: request.failed, all: request.all, contains: request.contains, limit: request.limit });
      }
      case "console":
        return observer.listMessages({ since: sinceOf(request), level: request.level, limit: request.limit });
      case "eval":
        return evaluate(request.expression);
    }
  };

  const sinceOf = (request: { since?: number; lastAction: boolean }) => (request.lastAction ? lastActionCursor : request.since ?? 0);

  /** Reads page state with the agent's own expression. It does not update the fingerprint that actions check. */
  const evaluate = async (expression: string) => {
    const before = await snapshot(page);
    let json: string | null;
    try {
      json = await Promise.race([
        page.evaluate<string | null>(evalScript(expression)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new DriverError("eval_timeout", `The expression did not finish in ${EVAL_TIMEOUT_MS / 1000} s.`,
          "Return a value without waiting on a promise that never resolves. Use `qavo browser wait-settle` to wait for the page.")), EVAL_TIMEOUT_MS)),
      ]);
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError("eval_failed", `The expression failed: ${messageOf(error)}`, EVAL_HINT);
    }
    const after = await snapshot(page);
    const pageChanged = after.fingerprint !== before.fingerprint || after.text !== before.text;
    const text = json === null ? "null" : observer.redact(json);
    const value = text.length > EVAL_CHARS ? { valueText: text.slice(0, EVAL_CHARS), truncated: true } : { value: JSON.parse(text) as unknown };
    return {
      ...value,
      pageChanged,
      ...(pageChanged && { warning: "The expression changed the page. eval is for reading, not for acting. Run `qavo browser snapshot` before the next action." }),
    };
  };

  /** Runs one indexed action after its guards. A dry run stops after the guards. */
  const targeted = async (request: { index: number; fingerprint?: string; dryRun: boolean }, action: Extract<Action, { index: number }>) => {
    const fingerprint = request.fingerprint ?? last?.fingerprint;
    if (!fingerprint) throw new DriverError("no_snapshot", "There is no snapshot to act on.", "Run `qavo browser snapshot` first. Actions use its indices and fingerprint.");
    const target = await describe(page, request.index);
    if (!target) throw new DriverError("refused", `Element ${request.index} is not on the page.`, REFUSAL_HINTS.missing);
    const guard = { fingerprint, allowHosts: options.allowHosts };
    try {
      if (request.dryRun) {
        await checkGuards(page, action, guard);
        return { dryRun: true, target, wouldAct: action.operation };
      }
      const before = await snapshot(page);
      const cursor = observer.cursor();
      await act(page, action, guard);
      const result = await afterAction(before, cursor, { target });
      // The state that the action was for, for example a switch that is now off, is often not in the page text.
      const after = last!.elements.find((element) => element.index === target.index);
      // After `type`, the value is the typed text, which output never repeats.
      const state = after && stateOf(action.operation === "TYPE_TEXT" ? { ...after, value: undefined } : after);
      return { ...result, target: { ...target, after: state ?? null } };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      throw new DriverError("refused", error.message, REFUSAL_HINTS[error.reason], { reason: error.reason, target });
    }
  };

  /** Settles, then reports what the action changed on the page, on the network, and in the console. */
  const afterAction = async (before: Snapshot, cursor: number, detail: object) => {
    lastActionCursor = cursor;
    last = await settledSnapshot(page);
    const changes = textChanges(before.text, last.text);
    // An overlay that covers or uncovers controls changes the element count, not the fingerprint.
    const pageChanged = last.fingerprint !== before.fingerprint || last.elements.length !== before.elements.length || changes !== undefined;
    return {
      ...detail, ...summary(last), pageChanged, ...(changes && { changes }),
      ...observer.activity(cursor),
    };
  };

  const server = createServer(async (incoming: IncomingMessage, response: ServerResponse) => {
    resetIdle();
    const body = await readBody(incoming);
    const reply = (status: number, payload: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    const run = queue.then(async () => {
      try {
        const request = Request.parse(JSON.parse(body));
        reply(200, { ok: true, ...(await handle(request)) });
      } catch (error) {
        const driverError = error instanceof DriverError ? error
          : error instanceof z.ZodError || error instanceof SyntaxError ? new DriverError("bad_request", messageOf(error), "Run `qavo browser --help`.")
          : new DriverError("driver_error", messageOf(error), "Run `qavo browser doctor`. The driver log is in its directory.");
        reply(200, { ok: false, error: driverError });
      }
    });
    queue = run;
    await run;
  });

  browser.on("disconnected", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await rm(paths.socket, { force: true });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(paths.socket, resolve)).catch(async (error: unknown) => {
    await browser.close();
    throw new DriverError("start_failed", `Could not listen on ${paths.socket}: ${messageOf(error)}`, "Run `qavo browser doctor`.");
  });
  await writeFile(paths.state, JSON.stringify({ pid: process.pid, startedAt, options }), { mode: 0o600 });
  resetIdle();
}

const summary = (state: Snapshot) => ({
  url: state.url, title: state.title, fingerprint: state.fingerprint, elements: state.elements.length,
  ...(state.covered && { covered: state.covered }),
});

/** The state fields of an element. The value of a sensitive field is never included (the snapshot has none). */
const stateOf = ({ value, checked, selected, expanded, pressed }: Snapshot["elements"][number]) =>
  Object.fromEntries(Object.entries({ value, checked, selected, expanded, pressed }).filter(([, field]) => field !== undefined));

const describe = (page: Page, index: number) => page.evaluate<Target | null>(`${PAGE_SCRIPT}\nwindow.__qavo.describe(${index})`);

/** Wraps an agent's expression so that the page returns JSON. Elements become a short tag, and cycles are cut. */
const evalScript = (expression: string) => `(async () => {
  const value = await (${expression}
  );
  const seen = new WeakSet();
  const json = JSON.stringify(value, (key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return "[function]";
    if (v instanceof Element) return "<" + v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + ">";
    if (v instanceof Node) return "[" + v.nodeName + "]";
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  });
  return json === undefined ? null : json;
})()`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]! : String(error));

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
