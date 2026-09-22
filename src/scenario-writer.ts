import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Scenario } from "./scenario.ts";
import { materializeDraft, type DraftScenario } from "./scenario-new.ts";

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "scenario";
}

export async function writeScenarios(directory: string, confirmed: { draft: DraftScenario; environmentNames: Record<string, string> }[]) {
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  const used = new Map<string, number>();
  for (const { draft, environmentNames } of confirmed) {
    const scenario = Scenario.parse(materializeDraft(draft, environmentNames));
    const base = slug(scenario.name);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const filename = `${base}${count === 1 ? "" : `-${count}`}.json`;
    const path = join(directory, filename);
    try {
      await writeFile(path, `${JSON.stringify(scenario, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`The scenario file already exists: ${path}`);
      throw error;
    }
    paths.push(path);
  }
  return paths;
}
