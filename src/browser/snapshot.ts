import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";

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

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate<Snapshot>(`${PAGE_SCRIPT}\nwindow.__qavo.snapshot()`);
}

export async function currentFingerprint(page: Page): Promise<string> {
  return page.evaluate<string>(`${PAGE_SCRIPT}\nwindow.__qavo.fingerprint()`);
}
