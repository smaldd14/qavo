import type { ConsoleMessage, Page, Request } from "playwright-core";

const KEEP = 500;
const FAILED_IN_SUMMARY = 5;
const MESSAGES_IN_SUMMARY = 3;
const TEXT_CHARS = 500;
const URL_CHARS = 300;
const BODY_CHARS = 4000;
/** Static files are left out of counts and lists unless they fail or `all` is set. */
const APP_TYPES = new Set(["document", "fetch", "xhr", "websocket", "eventsource"]);
const TEXT_CONTENT = /json|text\/|javascript|xml|x-www-form-urlencoded|graphql/;

export type NetworkEntry = {
  id: number;
  method: string;
  url: string;
  type: string;
  status?: number;
  failure?: string;
  durationMs?: number;
};

export type ConsoleEntry = { id: number; level: string; text: string; location?: string };

/** The browser cancels a request when the page navigates or the app aborts it, for example a query on unmount. That is not a failure. */
const ABORTED = "net::ERR_ABORTED";
const isFailed = (entry: NetworkEntry) => (entry.failure !== undefined && entry.failure !== ABORTED) || (entry.status ?? 0) >= 400;

/**
 * Records the page's requests, console messages, and uncaught errors, with one id sequence for both.
 * Each secret added with `addSecret` is replaced by *** in all output, because a model reads it.
 */
export function observe(page: Page) {
  let lastId = 0;
  // Two lists, so that the hundreds of modules that a dev server serves cannot push the app's calls out.
  const requests: NetworkEntry[] = [];
  const assets: NetworkEntry[] = [];
  const handles = new Map<number, Request>();
  const entries = new Map<Request, NetworkEntry & { startedAt: number }>();
  const messages: ConsoleEntry[] = [];
  const secrets = new Set<string>();

  const keep = <T extends { id: number }>(list: T[], entry: T) => {
    list.push(entry);
    const dropped = list.length > KEEP ? list.shift() : undefined;
    if (dropped) handles.delete(dropped.id);
  };

  const redact = (text: string) => {
    let result = text;
    for (const secret of secrets) result = result.replaceAll(secret, "***").replaceAll(encodeURIComponent(secret), "***");
    return result;
  };
  const clip = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}...` : text);

  page.on("request", (request) => {
    const entry = { id: ++lastId, method: request.method(), url: request.url(), type: request.resourceType(), startedAt: Date.now() };
    entries.set(request, entry);
    handles.set(entry.id, request);
    keep(APP_TYPES.has(entry.type) ? requests : assets, entry);
  });
  const finish = (request: Request, update: Partial<NetworkEntry>) => {
    const entry = entries.get(request);
    if (!entry) return;
    entries.delete(request);
    Object.assign(entry, update, { durationMs: Date.now() - entry.startedAt });
  };
  page.on("response", (response) => {
    const entry = entries.get(response.request());
    if (entry) entry.status = response.status();
  });
  page.on("requestfinished", (request) => finish(request, {}));
  page.on("requestfailed", (request) => finish(request, { failure: request.failure()?.errorText ?? "failed" }));
  page.on("console", (message: ConsoleMessage) => {
    // Chromium logs each failed request again as a console error. The network list already has it.
    if (message.text().startsWith("Failed to load resource:")) return;
    const { url, lineNumber } = message.location();
    keep(messages, { id: ++lastId, level: message.type(), text: message.text(), ...(url && { location: `${url}:${lineNumber}` }) });
  });
  page.on("pageerror", (error) => {
    const at = error.stack?.split("\n").find((line) => line.trim().startsWith("at "))?.trim();
    keep(messages, { id: ++lastId, level: "pageerror", text: `${error.name}: ${error.message}`, ...(at && { location: at }) });
  });

  const showRequest = ({ id, method, url, type, status, failure, durationMs }: NetworkEntry) => ({
    id, method, url: clip(redact(url), URL_CHARS), type,
    ...(status !== undefined && { status }), ...(failure !== undefined && { failure }),
    ...(durationMs !== undefined ? { durationMs } : failure === undefined && status === undefined && { pending: true }),
  });
  const showMessage = ({ id, level, text, location }: ConsoleEntry) => ({ id, level, text: clip(redact(text), TEXT_CHARS), ...(location && { location: redact(location) }) });
  const isError = (message: ConsoleEntry) => message.level === "error" || message.level === "pageerror";

  return {
    /** The last id so far. Pass it as `since` to see only what happens next. */
    cursor: () => lastId,

    addSecret(secret: string) {
      if (secret.length >= 3) secrets.add(secret);
    },

    redact,

    /** A short account of what happened after `since`, for an action result. */
    activity(since: number) {
      const newRequests = [...requests, ...assets].filter((entry) => entry.id > since).sort((a, b) => a.id - b.id);
      const newMessages = messages.filter((message) => message.id > since);
      const errors = newMessages.filter(isError);
      return {
        network: {
          requests: newRequests.filter((entry) => APP_TYPES.has(entry.type)).length,
        aborted: newRequests.filter((entry) => entry.failure === ABORTED).length,
          failed: newRequests.filter(isFailed).slice(0, FAILED_IN_SUMMARY).map(showRequest),
        },
        console: {
          errors: errors.length,
          warnings: newMessages.filter((message) => message.level === "warning").length,
          messages: errors.slice(0, MESSAGES_IN_SUMMARY).map(showMessage),
        },
      };
    },

    listRequests(filter: { since: number; failed: boolean; all: boolean; contains?: string; limit: number }) {
      const matches = [...requests, ...(filter.all ? assets : assets.filter(isFailed))].sort((a, b) => a.id - b.id).filter((entry) =>
        entry.id > filter.since
        && (!filter.failed || isFailed(entry))
        && (filter.contains === undefined || entry.url.includes(filter.contains)));
      return { requests: matches.slice(-filter.limit).map(showRequest), ...(matches.length > filter.limit && { omitted: matches.length - filter.limit }), cursor: lastId };
    },

    listMessages(filter: { since: number; level: "error" | "warning" | "all"; limit: number }) {
      const matches = messages.filter((message) =>
        message.id > filter.since
        && (filter.level === "all" || isError(message) || (filter.level === "warning" && message.level === "warning")));
      return { messages: matches.slice(-filter.limit).map(showMessage), ...(matches.length > filter.limit && { omitted: matches.length - filter.limit }), cursor: lastId };
    },

    /** One request with its bodies. Headers are left out, because they can hold tokens and cookies. */
    async requestDetail(id: number) {
      const entry = [...requests, ...assets].find((candidate) => candidate.id === id);
      const request = handles.get(id);
      if (!entry || !request) return undefined;
      const response = await request.response().catch(() => null);
      const requestType = request.headers()["content-type"];
      const responseType = response?.headers()["content-type"];
      const requestBody = request.postData();
      let responseBody: string | undefined;
      if (response && responseType && TEXT_CONTENT.test(responseType)) {
        responseBody = await response.text().catch(() => "(The body is no longer available. The page may have navigated.)");
      }
      const body = (text: string | null | undefined) => {
        if (text === null || text === undefined) return {};
        const redacted = redact(text);
        return redacted.length > BODY_CHARS ? { text: redacted.slice(0, BODY_CHARS), truncated: true } : { text: redacted };
      };
      const requestPart = body(requestBody);
      const responsePart = body(responseBody);
      return {
        ...showRequest(entry),
        ...(requestType && { requestContentType: requestType }),
        ...(requestPart.text !== undefined && { requestBody: requestPart.text }),
        ...(requestPart.truncated && { requestBodyTruncated: true }),
        ...(responseType && { responseContentType: responseType }),
        ...(responsePart.text !== undefined && { responseBody: responsePart.text }),
        ...(responsePart.truncated && { responseBodyTruncated: true }),
      };
    },
  };
}
export type Observer = ReturnType<typeof observe>;
