import { readFileSync } from "node:fs";
import type { Page, Request } from "playwright-core";

export type Operation = "CLICK" | "TYPE_TEXT" | "SELECT";

export interface Element {
  index: number;
  role: string;
  name: string;
  value?: string;
  sensitive?: true;
  checked?: boolean | string;
  selected?: boolean | string;
  expanded?: boolean | string;
  pressed?: boolean | string;
  haspopup?: string;
  context?: string;
  operations: Operation[];
  options?: { value: string; label: string }[];
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: Element[];
  omitted: number;
  scroll: { y: number; max: number };
  fingerprint: string;
}

export const PAGE_SCRIPT = readFileSync(new URL("./page.js", import.meta.url), "utf8");

const inFlight = new WeakMap<Page, Set<Request>>();

/** Counts the page's open fetch and XHR requests, so that a snapshot can wait for app data. Call before goto. */
export function trackRequests(page: Page) {
  if (inFlight.has(page)) return;
  const open = new Set<Request>();
  inFlight.set(page, open);
  page.on("request", (request) => {
    if (["fetch", "xhr"].includes(request.resourceType())) open.add(request);
  });
  page.on("requestfinished", (request) => open.delete(request));
  page.on("requestfailed", (request) => open.delete(request));
}

const QUIET_MS = 250;
const SETTLE_LIMIT_MS = 5000;
const POLL_MS = 50;

/**
 * Reads the page after it is quiet: no open fetch or XHR, and the same controls and text for QUIET_MS.
 * An app that renders after load, then shows a skeleton while it fetches data, is read only after the data.
 * After SETTLE_LIMIT_MS, returns the last read, for example on a page that polls forever.
 */
export async function settledSnapshot(page: Page): Promise<Snapshot> {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  let state = await snapshot(page);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    const next = await snapshot(page);
    const changed = next.fingerprint !== state.fingerprint || next.text !== state.text;
    const loading = (inFlight.get(page)?.size ?? 0) > 0;
    state = next;
    if (changed || loading) quietSince = Date.now();
    else if (Date.now() - quietSince >= QUIET_MS) break;
  }
  return state;
}

const NAVIGATION_ERROR = /Execution context was destroyed|Cannot find context|navigat/i;

/** Reads the page. When a navigation replaces the document during the read, waits and reads the new page. */
export async function snapshot(page: Page): Promise<Snapshot> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.waitForLoadState("domcontentloaded");
      return await page.evaluate<Snapshot>(`${PAGE_SCRIPT}\nwindow.__qavo.snapshot()`);
    } catch (error) {
      if (attempt >= 5 || !(error instanceof Error) || !NAVIGATION_ERROR.test(error.message)) throw error;
      await page.waitForTimeout(100);
    }
  }
}

export async function currentFingerprint(page: Page): Promise<string> {
  return page.evaluate<string>(`${PAGE_SCRIPT}\nwindow.__qavo.fingerprint()`);
}
