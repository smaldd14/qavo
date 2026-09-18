import type { Page } from "playwright-core";
import { PAGE_SCRIPT, currentFingerprint } from "./snapshot.ts";

export type Action =
  | { operation: "CLICK"; index: number }
  | { operation: "TYPE_TEXT"; index: number; text: string }
  | { operation: "SELECT"; index: number; value: string }
  | { operation: "SCROLL_DOWN" }
  | { operation: "SCROLL_UP" }
  | { operation: "WAIT" };

type RefusalReason = "stale" | "missing" | "hidden" | "disabled" | "not_editable" | "option" | "covered" | "host";

/** A guard stopped the action before any input reached the page. */
export class Refused extends Error {
  constructor(readonly reason: RefusalReason, message: string) {
    super(message);
    this.name = "Refused";
  }
}

type Prepared = { refused: Exclude<RefusalReason, "stale" | "host"> } | { x: number; y: number; href: string | null; setValue: boolean };

const WAIT_MS = 500;

export const isAllowedUrl = (url: string, allowHosts: string[]) => {
  const { protocol, host, hostname } = new URL(url);
  if (protocol === "about:" || protocol === "data:" || protocol === "blob:") return true;
  return allowHosts.includes(host) || allowHosts.includes(hostname);
};

const callPage = <T>(page: Page, call: string) => page.evaluate<T>(`${PAGE_SCRIPT}\nwindow.__qavo.${call}`);

/**
 * Runs one action through the node stored by the last snapshot.
 * Refuses when the page changed since `fingerprint`, or when the target is gone, hidden, disabled, covered,
 * or links to a host that is not in `allowHosts`.
 */
export async function act(page: Page, action: Action, guard: { fingerprint: string; allowHosts: string[] }) {
  if (action.operation === "WAIT") {
    await page.waitForTimeout(WAIT_MS);
    return;
  }
  if (action.operation === "SCROLL_DOWN" || action.operation === "SCROLL_UP") {
    const direction = action.operation === "SCROLL_DOWN" ? 1 : -1;
    await page.evaluate(`scrollBy(0, ${direction} * innerHeight * 0.8)`);
    await callPage(page, "settle(0, false)");
    return;
  }

  if ((await currentFingerprint(page)) !== guard.fingerprint) {
    throw new Refused("stale", "The page changed after the decision.");
  }
  const optionValue = action.operation === "SELECT" ? action.value : null;
  const prepared = await callPage<Prepared>(
    page,
    `prepare(${action.index}, ${JSON.stringify(action.operation)}, ${JSON.stringify(optionValue)})`,
  );
  if ("refused" in prepared) throw new Refused(prepared.refused, `The target is ${prepared.refused.replace("_", " ")}.`);
  if (prepared.href && !isAllowedUrl(prepared.href, guard.allowHosts)) {
    throw new Refused("host", `The link goes to ${new URL(prepared.href).host}, which is not in allowHosts.`);
  }

  if (action.operation === "SELECT" || (action.operation === "TYPE_TEXT" && prepared.setValue)) {
    const value = action.operation === "SELECT" ? action.value : action.text;
    await callPage(page, `setValue(${action.index}, ${JSON.stringify(value)})`);
  } else {
    await page.mouse.click(prepared.x, prepared.y);
    if (action.operation === "TYPE_TEXT") {
      await page.keyboard.press("ControlOrMeta+A");
      if (action.text) await page.keyboard.insertText(action.text);
      else await page.keyboard.press("Backspace");
    }
  }
  // A click can start a navigation, which destroys the page context. The next snapshot waits for the new page.
  await callPage(page, `settle(${action.index}, ${action.operation === "TYPE_TEXT"})`).catch(() => undefined);
}

/** Aborts main-frame navigations to hosts that are not in allowHosts, for example a form post or a script redirect. */
export async function blockOtherHosts(page: Page, allowHosts: string[]) {
  await page.route("**/*", (route) => {
    const request = route.request();
    const leavesAllowedHosts =
      request.isNavigationRequest() && request.frame() === page.mainFrame() && !isAllowedUrl(request.url(), allowHosts);
    return leavesAllowedHosts ? route.abort("blockedbyclient") : route.continue();
  });
}
