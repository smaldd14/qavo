import { materializeDraft, normalizeUrl, type DraftScenario, type DraftStep } from "./scenario-new.ts";

export interface Terminal {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface ConfirmedScenario {
  draft: DraftScenario;
  environmentNames: Record<string, string>;
}

/** Asks until the answer is a valid URL. An empty answer keeps `current` when there is one. */
export async function askUrl(terminal: Terminal, output: (line: string) => void, current?: string) {
  while (true) {
    const answer = (await terminal.question(current ? `Start URL [${current}]: ` : "Start URL: ")).trim();
    if (!answer && current) return current;
    try {
      return normalizeUrl(answer);
    } catch (error) {
      output((error as Error).message);
    }
  }
}

function printDraft(draft: DraftScenario, output: (line: string) => void) {
  output(`\n${draft.name ?? "Unnamed scenario"} (${draft.url})`);
  for (const [index, step] of draft.steps.entries()) {
    output(`  ${index + 1}. ${step.intent}`);
    if (step.expect) output(`     Expect: ${step.expect}`);
    if (step.dataKeys.length) output(`     Data: ${step.dataKeys.join(", ")}`);
  }
  for (const note of draft.notes) output(`  Not a step: ${note}`);
}

async function editStep(terminal: Terminal, step: DraftStep): Promise<DraftStep> {
  const intent = await terminal.question(`Step intent [${step.intent}]: `);
  const expected = await terminal.question(`Expected result [${step.expect ?? "none"}]: `);
  const keys = await terminal.question(`Data keys [${step.dataKeys.join(", ")}]: `);
  return {
    intent: intent.trim() || step.intent,
    expect: expected.trim() === "none" ? null : expected.trim() || step.expect,
    dataKeys: keys.trim() ? keys.split(",").map((key) => key.trim()).filter(Boolean) : step.dataKeys,
  };
}

async function editDraft(terminal: Terminal, draft: DraftScenario, output: (line: string) => void): Promise<DraftScenario> {
  const name = await terminal.question(`Scenario name [${draft.name ?? "missing"}]: `);
  const url = await askUrl(terminal, output, draft.url);
  const steps: DraftStep[] = [];
  for (const step of draft.steps) steps.push(await editStep(terminal, step));
  return { ...draft, name: name.trim() || draft.name, url, steps };
}

async function askName(terminal: Terminal, draft: DraftScenario): Promise<DraftScenario> {
  if (draft.name) return draft;
  const suggestion = draft.steps[0]!.intent.slice(0, 60);
  const answer = await terminal.question(`Scenario name [${suggestion}]: `);
  return { ...draft, name: answer.trim() || suggestion };
}

async function askEnvironmentNames(terminal: Terminal, drafts: DraftScenario[], output: (line: string) => void) {
  const names: Record<string, string> = {};
  for (const key of [...new Set(drafts.flatMap((draft) => draft.steps.flatMap((step) => step.dataKeys)))]) {
    while (!names[key]) {
      const answer = await terminal.question(`Environment variable NAME (not the value) for data key "${key}" [${key.toUpperCase()}]: `);
      const name = answer.trim() || key.toUpperCase();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names[key] = name;
      else output(`"${name}" is not a valid environment variable name. Use letters, digits, and underscores, for example QA_PASSWORD.`);
    }
  }
  return names;
}

export async function confirmDrafts(options: {
  drafts: DraftScenario[];
  terminal: Terminal;
  output?: (line: string) => void;
}): Promise<ConfirmedScenario[] | undefined> {
  const output = options.output ?? console.log;
  let drafts: DraftScenario[] = [];
  for (const draft of options.drafts) drafts.push(await askName(options.terminal, draft));
  while (true) {
    for (const draft of drafts) printDraft(draft, output);
    const choice = (await options.terminal.question("\nApprove, edit, or cancel? [a/e/c] ")).trim().toLowerCase();
    if (choice === "c") return undefined;
    if (choice === "e") {
      const edited: DraftScenario[] = [];
      for (const draft of drafts) edited.push(await editDraft(options.terminal, draft, output));
      drafts = edited;
      continue;
    }
    if (choice === "a") {
      const environmentNames = await askEnvironmentNames(options.terminal, drafts, output);
      drafts.forEach((draft) => materializeDraft(draft, environmentNames));
      return drafts.map((draft) => ({ draft, environmentNames }));
    }
    output("Choose a, e, or c.");
  }
}
