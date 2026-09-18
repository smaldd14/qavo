import { describe, expect, test } from "vitest";
import { snapshot, type Element } from "../src/browser/snapshot.ts";
import { useFixtureBrowser } from "./browser.ts";

const fixtures = useFixtureBrowser();
const byName = (elements: Element[], name: string) => elements.find((e) => e.name === name);

describe("snapshot", () => {
  test("form: roles, names, values, and operations", async () => {
    const page = await fixtures.open("form.html");
    const { elements, title, text } = await snapshot(page);
    expect(title).toBe("Contact form");
    expect(text).toContain("Contact us");

    expect(byName(elements, "Full name")).toMatchObject({ role: "textbox", value: "", operations: ["TYPE_TEXT"] });
    expect(byName(elements, "Email")).toMatchObject({ role: "textbox", operations: ["TYPE_TEXT"] });
    expect(byName(elements, "Message")).toMatchObject({ role: "textbox", operations: ["TYPE_TEXT"] });
    expect(byName(elements, "Send message")).toMatchObject({ role: "button", operations: ["CLICK"] });
    expect(byName(elements, "Pro")).toMatchObject({ role: "radio", checked: false, context: expect.stringContaining("Plan") });
    expect(byName(elements, "Basic")).toMatchObject({ checked: true });
  });

  test("form: a checkbox is never offered TYPE_TEXT", async () => {
    const page = await fixtures.open("form.html");
    const { elements } = await snapshot(page);
    expect(byName(elements, "Send me the newsletter")).toMatchObject({
      role: "checkbox",
      checked: false,
      operations: ["CLICK"],
    });
    for (const e of elements.filter((e) => ["checkbox", "radio", "switch", "button"].includes(e.role))) {
      expect(e.operations).not.toContain("TYPE_TEXT");
    }
  });

  test("form: a password field hides its value, a readonly field cannot be typed into", async () => {
    const page = await fixtures.open("form.html");
    await page.fill("#password", "hunter2");
    const { elements } = await snapshot(page);
    const password = byName(elements, "Password");
    expect(password).toMatchObject({ sensitive: true, operations: ["TYPE_TEXT"] });
    expect(password).not.toHaveProperty("value");
    expect(JSON.stringify(elements)).not.toContain("hunter2");
    expect(byName(elements, "Account number")).toMatchObject({ value: "A-100", operations: ["CLICK"] });
  });

  test("form: a native select offers SELECT with its enabled options", async () => {
    const page = await fixtures.open("form.html");
    const { elements } = await snapshot(page);
    const topic = byName(elements, "Topic");
    expect(topic).toMatchObject({ role: "combobox", value: "Choose a topic", operations: ["SELECT"] });
    expect(topic?.options?.map((o) => o.label)).toEqual(["Choose a topic", "Billing", "Support"]);
  });

  test("combobox: the input allows TYPE_TEXT and CLICK, and suggestions appear as options", async () => {
    const page = await fixtures.open("combobox.html");
    const before = await snapshot(page);
    expect(byName(before.elements, "City")).toMatchObject({
      role: "combobox",
      expanded: false,
      operations: ["TYPE_TEXT", "CLICK"],
    });
    await page.fill("#city", "L");
    await page.getByRole("option", { name: "Lisbon" }).waitFor();
    const after = await snapshot(page);
    expect(after.elements.filter((e) => e.role === "option").map((e) => e.name)).toEqual(["Lisbon", "London", "Lyon"]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("table: row buttons carry row context, icon buttons get a name", async () => {
    const page = await fixtures.open("table.html");
    const { elements } = await snapshot(page);
    const edits = elements.filter((e) => e.name === "Edit");
    expect(edits.map((e) => e.context)).toEqual([
      expect.stringContaining("WO-1 Fix leaking faucet"),
      expect.stringContaining("WO-2 Replace air filter"),
    ]);
    expect(byName(elements, "Delete WO-1")).toMatchObject({ role: "button" });
    expect(byName(elements, "icon trash 2")).toMatchObject({ context: expect.stringContaining("WO-2") });
  });

  test("modal: only controls inside an open modal dialog are listed", async () => {
    const page = await fixtures.open("modal.html");
    const closed = await snapshot(page);
    expect(closed.elements.map((e) => e.name)).toEqual(["Add tenant", "Help"]);
    await page.click("#open");
    const open = await snapshot(page);
    expect(open.elements.map((e) => e.name)).toEqual(["Tenant name", "Cancel", "Save tenant"]);
  });

  test("hidden, disabled, and covered controls are not listed", async () => {
    const page = await fixtures.open("hidden.html");
    const { elements } = await snapshot(page);
    expect(elements.map((e) => e.name)).toEqual(["Visible button", "Below the fold"]);
  });

  test("indexes are stable for the same node across snapshots", async () => {
    const page = await fixtures.open("table.html");
    const first = await snapshot(page);
    const second = await snapshot(page);
    expect(second.elements.map((e) => e.index)).toEqual(first.elements.map((e) => e.index));
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test("the fingerprint changes when a form value changes", async () => {
    const page = await fixtures.open("form.html");
    const before = await snapshot(page);
    await page.fill("#name", "Ada");
    const after = await snapshot(page);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
