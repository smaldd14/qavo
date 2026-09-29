import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** A failure that tells the agent what to do next. The CLI prints it as `{ ok: false, error }`. */
export class DriverError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly detail?: object) {
    super(message);
    this.name = "DriverError";
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.hint && { hint: this.hint }), ...this.detail };
  }
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
/** macOS allows 104 bytes for a Unix socket path, including the final NUL. Linux allows 108. */
const MAX_SOCKET_PATH_BYTES = 103;

/** The driver's directory: `$QAVO_HOME/drivers/<name>/`, where QAVO_HOME defaults to `~/.qavo`. */
export function driverPaths(name: string, env: NodeJS.ProcessEnv = process.env) {
  if (!NAME.test(name)) {
    throw new DriverError("bad_name", `The driver name "${name}" is not valid.`, "Use 1 to 40 letters, digits, - or _.");
  }
  const dir = join(env.QAVO_HOME ?? join(homedir(), ".qavo"), "drivers", name);
  const socket = join(dir, "driver.sock");
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
    throw new DriverError("path_too_long", `The driver socket path ${socket} is longer than the ${MAX_SOCKET_PATH_BYTES}-byte Unix limit.`,
      "Set QAVO_HOME to a shorter directory, for example `export QAVO_HOME=/tmp/qavo`, or use a shorter --name.");
  }
  return { name, dir, socket, state: join(dir, "state.json"), log: join(dir, "driver.log"), screenshots: join(dir, "screenshots") };
}
export type DriverPaths = ReturnType<typeof driverPaths>;

/** What `qavo browser start` passes to the driver process. */
export const DriverOptions = z.object({
  url: z.url(),
  headed: z.boolean(),
  storageState: z.string().optional(),
  allowHosts: z.array(z.string()).min(1),
  idleMinutes: z.number().positive(),
});
export type DriverOptions = z.infer<typeof DriverOptions>;

const Index = z.number().int().positive();
const Target = { index: Index, fingerprint: z.string().optional(), dryRun: z.boolean().default(false) };
/** Which recorded events to list: after a cursor, or since the start of the last action. */
const Since = {
  since: z.number().int().nonnegative().optional(),
  lastAction: z.boolean().default(false),
  limit: z.number().int().positive().default(50),
};

/** One command sent to the driver over its socket. */
export const Request = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }),
  z.object({ command: z.literal("stop") }),
  z.object({ command: z.literal("open"), url: z.string().min(1) }),
  z.object({ command: z.literal("snapshot") }),
  z.object({ command: z.literal("wait-settle") }),
  z.object({ command: z.literal("click"), ...Target }),
  z.object({
    command: z.literal("type"),
    ...Target,
    text: z.string(),
    /** The environment variable that held the text. The text is never echoed. */
    env: z.string().optional(),
  }),
  z.object({ command: z.literal("select"), ...Target, value: z.string() }),
  z.object({ command: z.literal("press"), key: z.string().min(1) }),
  z.object({ command: z.literal("scroll"), direction: z.enum(["up", "down"]) }),
  z.object({ command: z.literal("screenshot"), path: z.string().optional(), fullPage: z.boolean().default(false) }),
  z.object({
    command: z.literal("network"),
    /** One request with its bodies. Without it, a list. */
    id: Index.optional(),
    failed: z.boolean().default(false),
    all: z.boolean().default(false),
    contains: z.string().optional(),
    ...Since,
  }),
  z.object({ command: z.literal("console"), level: z.enum(["error", "warning", "all"]).default("all"), ...Since }),
  /** Runs a JavaScript expression in the page to read state. It is not an action and passes no guards. */
  z.object({ command: z.literal("eval"), expression: z.string().min(1) }),
]);
export type Request = z.infer<typeof Request>;
/** A request as the CLI sends it. The driver fills in the defaults. */
export type RequestInput = z.input<typeof Request>;
