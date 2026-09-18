import { describe, expect, test } from "vitest";
import type { Page } from "playwright-core";
import { act, Refused, type Action } from "../src/browser/act.ts";
import { snapshot } from "../src/browser/snapshot.ts";
import { useFixtureBrowser } from "./browser.ts";

const fixtures = useFixtureBrowser();
const allowHosts = ["127.0.0.1"];

async function indexOf(page: Page, name: string) {
  const element = (await snapshot(page)).elements.find((e) => e.name === name);
  if (!element) throw new Error(`No element named ${name}`);
  return element.index;
}

async function actNow(page: Page, action: Action) {
  const { fingerprint } = await snapshot(page);
  return act(page, action, { fingerprint, allowHosts });
}

describe("act", () => {
  test("a click on a covered button is refused, and the button gets no click", async () => {
    const page = await fixtures.open("table.html");
    const state = await snapshot(page);
    const edit = state.elements.find((e) => e.name === "Edit")!;
    await page.evaluate(`document.body.insertAdjacentHTML("beforeend",
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4)">Toast</div>')`);
    const attempt = act(page, { operation: "CLICK", index: edit.index }, { fingerprint: state.fingerprint, allowHosts });
    await expect(attempt).rejects.toMatchObject({ reason: "covered" });
    expect(await page.textContent("#log")).toBe("");
  });

  test("an action on a stale page is refused", async () => {
    const page = await fixtures.open("form.html");
    const state = await snapshot(page);
    const send = state.elements.find((e) => e.name === "Send message")!;
    await page.fill("#name", "Changed after the decision");
    const attempt = act(page, { operation: "CLICK", index: send.index }, { fingerprint: state.fingerprint, allowHosts });
    await expect(attempt).rejects.toBeInstanceOf(Refused);
    await expect(attempt).rejects.toMatchObject({ reason: "stale" });
    expect(await page.textContent("#status")).toBe("");
  });

  test("TYPE_TEXT replaces the text that is in the field", async () => {
    const page = await fixtures.open("form.html");
    await page.fill("#name", "Old name");
    await actNow(page, { operation: "TYPE_TEXT", index: await indexOf(page, "Full name"), text: "Ada Lovelace" });
    expect(await page.inputValue("#name")).toBe("Ada Lovelace");
  });

  test("TYPE_TEXT is refused for a checkbox", async () => {
    const page = await fixtures.open("form.html");
    const index = await indexOf(page, "Send me the newsletter");
    await expect(actNow(page, { operation: "TYPE_TEXT", index, text: "yes" })).rejects.toMatchObject({ reason: "not_editable" });
  });

  test("SELECT sets a native select and fires change", async () => {
    const page = await fixtures.open("form.html");
    await actNow(page, { operation: "SELECT", index: await indexOf(page, "Topic"), value: "billing" });
    expect(await page.inputValue("#topic")).toBe("billing");
    expect(await page.textContent("#status")).toBe("Topic: billing");
  });

  test("SELECT is refused for a disabled option", async () => {
    const page = await fixtures.open("form.html");
    const index = await indexOf(page, "Topic");
    await expect(actNow(page, { operation: "SELECT", index, value: "legacy" })).rejects.toMatchObject({ reason: "option" });
  });

  test("after TYPE_TEXT in a combobox, the suggestions are in the next snapshot", async () => {
    const page = await fixtures.open("combobox.html");
    await actNow(page, { operation: "TYPE_TEXT", index: await indexOf(page, "City"), text: "Li" });
    const options = (await snapshot(page)).elements.filter((e) => e.role === "option");
    expect(options.map((e) => e.name)).toEqual(["Lisbon"]);
    await actNow(page, { operation: "CLICK", index: options[0]!.index });
    expect(await page.textContent("#chosen")).toBe("Chosen: Lisbon");
  });

  test("a click on a row button hits that row", async () => {
    const page = await fixtures.open("table.html");
    const edits = (await snapshot(page)).elements.filter((e) => e.name === "Edit");
    await actNow(page, { operation: "CLICK", index: edits[1]!.index });
    expect(await page.textContent("#log")).toBe("WO-2: Edit");
  });

  test("a link to a host that is not allowed is refused", async () => {
    const page = await fixtures.open("form.html");
    const index = await indexOf(page, "Terms");
    await expect(actNow(page, { operation: "CLICK", index })).rejects.toMatchObject({ reason: "host" });
    expect(new URL(page.url()).host).toMatch(/^127\.0\.0\.1/);
  });

  test("an element below the fold is scrolled into view, then clicked", async () => {
    const page = await fixtures.open("hidden.html");
    await page.evaluate(`document.getElementById("below").onclick = () => document.title = "clicked"`);
    await actNow(page, { operation: "CLICK", index: await indexOf(page, "Below the fold") });
    expect(await page.title()).toBe("clicked");
  });

  test("SCROLL_DOWN moves the page", async () => {
    const page = await fixtures.open("hidden.html");
    await actNow(page, { operation: "SCROLL_DOWN" });
    expect((await snapshot(page)).scroll.y).toBeGreaterThan(0);
  });
});
