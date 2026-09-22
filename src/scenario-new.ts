import type { InputBlock, ScenarioInput } from "./scenario-input.ts";

export interface DraftStep {
  intent: string;
  expect: string | null;
  dataKeys: string[];
}

export interface DraftScenario {
  name: string | null;
  url: string;
  steps: DraftStep[];
  /** Input text that did not become a step, shown so that the user can see what was left out. */
  notes: string[];
}

/** Adds `http://` when the scheme is absent, so that `localhost:5173` works. */
export function normalizeUrl(value: string) {
  const trimmed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = URL.parse(withScheme);
  if (!trimmed || !url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error(`Not a valid http or https URL: ${value}`);
  return url.href;
}

function tableSteps(rows: string[][]): DraftStep[] {
  const header = rows[0]!.map((cell) => cell.toLowerCase());
  const actionColumn = header.findIndex((cell) => /action|step|instruction|procedure/.test(cell));
  const expectColumn = header.findIndex((cell) => /expect|result/.test(cell));
  if (actionColumn >= 0) {
    return rows.slice(1)
      .filter((row) => row[actionColumn])
      .map((row) => ({ intent: row[actionColumn]!, expect: (expectColumn >= 0 && row[expectColumn]) || null, dataKeys: [] }));
  }
  return rows.map((row) => {
    const cells = row.filter(Boolean);
    if (/^\d+\.?$/.test(cells[0] ?? "")) cells.shift();
    return cells.length === 2 ? { intent: cells[0]!, expect: cells[1]!, dataKeys: [] } : { intent: cells.join(" | "), expect: null, dataKeys: [] };
  }).filter((step) => step.intent);
}

/**
 * Builds scenarios from the input structure only. A heading starts a scenario. List items and table rows are steps.
 * Paragraphs are steps only in a scenario with no list or table; otherwise they are notes.
 */
export function draftScenarios(input: ScenarioInput, url: string): DraftScenario[] {
  const sections: { name: string | null; blocks: InputBlock[] }[] = [];
  for (const block of input.blocks) {
    if (block.kind === "heading" || sections.length === 0) sections.push({ name: block.kind === "heading" ? block.text : null, blocks: [] });
    if (block.kind !== "heading") sections.at(-1)!.blocks.push(block);
  }
  return sections.flatMap(({ name, blocks }) => {
    const structured = blocks.some((block) => block.kind === "item" || block.kind === "table");
    const steps: DraftStep[] = [];
    const notes: string[] = [];
    for (const block of blocks) {
      if (block.kind === "table") steps.push(...tableSteps(block.rows));
      else if (block.kind === "item" || (block.kind === "paragraph" && !structured)) steps.push({ intent: block.text, expect: null, dataKeys: [] });
      else if (block.kind === "paragraph") notes.push(block.text);
      else if (block.kind === "expect" && steps.at(-1) && !steps.at(-1)!.expect) steps.at(-1)!.expect = block.text;
      else notes.push(`Expected: ${block.text}`);
    }
    return steps.length > 0 ? [{ name, url, steps, notes }] : [];
  });
}

export function materializeDraft(draft: DraftScenario, environmentNames: Record<string, string>) {
  if (!draft.name) throw new Error("The scenario needs a name before approval.");
  return {
    name: draft.name,
    url: draft.url,
    steps: draft.steps.map((step) => ({
      intent: step.intent,
      ...(step.expect && { expect: step.expect }),
      ...(step.dataKeys.length > 0 && { data: Object.fromEntries(step.dataKeys.map((key) => [key, `@env:${environmentNames[key]}`])) }),
    })),
  };
}
