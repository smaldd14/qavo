import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Agents on other machines learn `qavo browser` only from the skill. It must name each command and code that they can meet.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reference = read("skills/qavo-browser/reference.md");
const documented = (name: string) => reference.includes(`\`${name}\``);

test("the reference names each qavo browser command", () => {
  const commands = [...read("src/driver/commands.ts").matchAll(/^  "?([a-z-]+)"?: \{\n    usage:/gm)].map((match) => match[1]!);
  expect(commands.length).toBeGreaterThan(10);
  expect(commands.filter((command) => !documented(command))).toEqual([]);
});

test("the reference names each error code and refusal reason", () => {
  const sources = [...readdirSync(new URL("../src/driver", import.meta.url)).map((file) => read(`src/driver/${file}`)), read("bin/qavo.js")];
  const codes = sources.flatMap((source) => [...source.matchAll(/DriverError\("([a-z_]+)"|code: "([a-z_]+)"/g)].map((match) => (match[1] ?? match[2])!));
  const reasons = read("src/browser/act.ts").match(/type RefusalReason = (.*);/)![1]!.match(/[a-z_]+/g)!;
  expect(codes.length).toBeGreaterThan(15);
  expect([...new Set([...codes, ...reasons])].filter((code) => !documented(code))).toEqual([]);
});

test("each relative link in a skill goes to a file that exists", () => {
  const skills = new URL("../skills/", import.meta.url);
  const files = readdirSync(skills, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".md") && !path.includes("templates"));
  const broken = files.flatMap((file) =>
    [...read(`skills/${file}`).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !/^[a-z]+:/.test(target) && !existsSync(new URL(target, new URL(file, skills))))
      .map((target) => `${file} -> ${target}`));
  expect(files.length).toBeGreaterThan(2);
  expect(broken).toEqual([]);
});
