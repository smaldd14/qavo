import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { readScenarioInput } from "../src/scenario-input.ts";

const paragraph = (text: string, properties = "") => `<w:p>${properties && `<w:pPr>${properties}</w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;

describe("readScenarioInput", () => {
  test("reads text from stdin and text files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qavo-input-"));
    const path = join(directory, "instructions.txt");
    await writeFile(path, "# Contact\n\nCheck the contact\nform.\n\n1) Submit it\n* Expected: Thanks appears");

    await expect(readScenarioInput({ stdin: "  Check the form.  " })).resolves.toEqual({ blocks: [{ kind: "paragraph", text: "Check the form." }], source: "stdin" });
    await expect(readScenarioInput({ file: path })).resolves.toEqual({
      blocks: [
        { kind: "heading", text: "Contact" },
        { kind: "paragraph", text: "Check the contact form." },
        { kind: "item", text: "Submit it" },
        { kind: "expect", text: "Thanks appears" },
      ],
      source: path,
    });
  });

  test("reads DOCX headings, numbered paragraphs, and table rows and columns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qavo-docx-"));
    const path = join(directory, "instructions.docx");
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="x"><w:body>
      ${paragraph("Contact form", '<w:pStyle w:val="Heading1"/>')}
      ${paragraph("Open the form", '<w:numPr><w:numId w:val="1"/></w:numPr>')}
      ${paragraph("Expected: The form shows")}
      <w:tbl><w:tr>${cell("Action")}${cell("Expected")}</w:tr><w:tr>${cell("Submit form")}${cell("Success appears")}</w:tr></w:tbl>
    </w:body></w:document>`);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));

    expect((await readScenarioInput({ file: path })).blocks).toEqual([
      { kind: "heading", text: "Contact form" },
      { kind: "item", text: "Open the form" },
      { kind: "expect", text: "The form shows" },
      { kind: "table", rows: [["Action", "Expected"], ["Submit form", "Success appears"]] },
    ]);
  });

  test("rejects unsupported files and empty input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qavo-input-"));
    const path = join(directory, "instructions.md");
    await writeFile(path, "text");
    await expect(readScenarioInput({ file: path })).rejects.toThrow(".txt or .docx");
    await expect(readScenarioInput({ stdin: "   " })).rejects.toThrow("cannot be empty");
  });
});
