import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { confirmDrafts, type Terminal } from "../src/scenario-confirm.ts";
import { readScenarioInput } from "../src/scenario-input.ts";
import { draftScenarios, materializeDraft, normalizeUrl, type DraftScenario } from "../src/scenario-new.ts";
import { writeScenarios } from "../src/scenario-writer.ts";

const url = "http://localhost:5173/";

async function draftsFrom(text: string) {
  return draftScenarios(await readScenarioInput({ stdin: text }), url);
}

function terminal(answers: string[], prompts: string[] = []): Terminal {
  return { question: async (prompt) => { prompts.push(prompt); return answers.shift() ?? ""; }, close() {} };
}

const contactForm: DraftScenario = {
  name: "Contact form",
  url: "https://example.test/contact",
  steps: [{ intent: "Submit the contact form", expect: "A success message appears", dataKeys: ["email"] }],
  notes: [],
};

describe("normalizeUrl", () => {
  test("adds http to a host without a scheme and keeps https", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeUrl(" https://app.example.test/settings ")).toBe("https://app.example.test/settings");
  });

  test.each(["", "ftp://example.test", "http://"])("rejects %j", (value) => {
    expect(() => normalizeUrl(value)).toThrow("Not a valid http or https URL");
  });
});

describe("draftScenarios", () => {
  test("keeps prose with no list as one step, word for word", async () => {
    const text = "go to settings then notifications and make sure the request status updates toggles on and off";
    expect(await draftsFrom(text)).toEqual([{ name: null, url, steps: [{ intent: text, expect: null, dataKeys: [] }], notes: [] }]);
  });

  test("makes each list item a step and attaches Expected lines to the step above", async () => {
    const [draft] = await draftsFrom(`Check the notification switch.
1. Go to settings then notifications
2. Turn off the Request Status Updates in-app switch
   Expected: The switch is off
- Turn it back on
- Expected result: The switch is on`);
    expect(draft!.steps).toEqual([
      { intent: "Go to settings then notifications", expect: null, dataKeys: [] },
      { intent: "Turn off the Request Status Updates in-app switch", expect: "The switch is off", dataKeys: [] },
      { intent: "Turn it back on", expect: "The switch is on", dataKeys: [] },
    ]);
    expect(draft!.notes).toEqual(["Check the notification switch."]);
  });

  test("starts a scenario at each heading and uses the heading as the name", async () => {
    const drafts = await draftsFrom(`# Notifications
- Turn off the switch

# Profile
Change the display name to Ada`);
    expect(drafts.map((draft) => [draft.name, draft.steps.map((step) => step.intent)])).toEqual([
      ["Notifications", ["Turn off the switch"]],
      ["Profile", ["Change the display name to Ada"]],
    ]);
  });

  test("keeps an Expected line with no step above it as a note", async () => {
    const [draft] = await draftsFrom("Expected: nothing\n- Open settings");
    expect(draft!.notes).toEqual(["Expected: nothing"]);
    expect(draft!.steps).toHaveLength(1);
  });

  test("reads table rows by their Action and Expected columns", () => {
    const drafts = draftScenarios({ source: "test", blocks: [{ kind: "table", rows: [
      ["#", "Action", "Expected result"],
      ["1", "Open settings", "Settings page shows"],
      ["2", "Open notifications", ""],
    ] }] }, url);
    expect(drafts[0]!.steps).toEqual([
      { intent: "Open settings", expect: "Settings page shows", dataKeys: [] },
      { intent: "Open notifications", expect: null, dataKeys: [] },
    ]);
  });

  test("reads a table with no header as step and expected pairs, without a number column", () => {
    const drafts = draftScenarios({ source: "test", blocks: [{ kind: "table", rows: [["1.", "Open settings", "Settings page shows"]] }] }, url);
    expect(drafts[0]!.steps).toEqual([{ intent: "Open settings", expect: "Settings page shows", dataKeys: [] }]);
  });

  test("drops a heading with no steps, such as a document title", async () => {
    expect((await draftsFrom("# Test plan\n# Notifications\n- Open settings")).map((draft) => draft.name)).toEqual(["Notifications"]);
  });
});

describe("confirmDrafts", () => {
  test("suggests the first step as the name of an unnamed scenario", async () => {
    const prompts: string[] = [];
    const [draft] = await draftsFrom("Open settings");
    const confirmed = await confirmDrafts({ drafts: [draft!], terminal: terminal(["", "a"], prompts), output: () => {} });
    expect(prompts[0]).toBe("Scenario name [Open settings]: ");
    expect(confirmed?.[0]?.draft.name).toBe("Open settings");
  });

  test("asks again for an environment variable name that is not valid", async () => {
    const lines: string[] = [];
    const confirmed = await confirmDrafts({ drafts: [contactForm], terminal: terminal(["a", "localhost:5173", "QA_EMAIL"]), output: (line) => lines.push(line) });
    expect(confirmed?.[0]?.environmentNames).toEqual({ email: "QA_EMAIL" });
    expect(lines.at(-1)).toContain('"localhost:5173" is not a valid environment variable name');
  });

  test("asks again for a start URL that is not valid during an edit", async () => {
    const lines: string[] = [];
    const answers = ["e", "", "ftp://nope", "localhost:3000", "", "", "", "c"];
    await confirmDrafts({ drafts: [{ ...contactForm, steps: [{ ...contactForm.steps[0]!, dataKeys: [] }] }], terminal: terminal(answers), output: (line) => lines.push(line) });
    expect(lines).toContain("Not a valid http or https URL: ftp://nope");
    expect(lines).toContain("\nContact form (http://localhost:3000/)");
  });

  test("cancels without writing", async () => {
    await expect(confirmDrafts({ drafts: [contactForm], terminal: terminal(["c"]), output: () => {} })).resolves.toBeUndefined();
  });

  test("materializes data keys as environment references", () => {
    expect(materializeDraft(contactForm, { email: "QA_EMAIL" })).toEqual({
      name: "Contact form",
      url: "https://example.test/contact",
      steps: [{ intent: "Submit the contact form", expect: "A success message appears", data: { email: "@env:QA_EMAIL" } }],
    });
  });
});

describe("writeScenarios", () => {
  test("writes one safe file per approved scenario and refuses collisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qavo-scenarios-"));
    const confirmed = [{ draft: contactForm, environmentNames: { email: "QA_EMAIL" } }];
    const paths = await writeScenarios(directory, confirmed);
    expect(paths[0]).toMatch(/contact-form\.json$/);
    expect(JSON.parse(await readFile(paths[0]!, "utf8")).steps[0].data).toEqual({ email: "@env:QA_EMAIL" });
    await expect(writeScenarios(directory, confirmed)).rejects.toThrow("already exists");
  });
});
