import { readFile } from "node:fs/promises";
import JSZip from "jszip";

export type InputBlock =
  | { kind: "heading" | "paragraph" | "item" | "expect"; text: string }
  | { kind: "table"; rows: string[][] };

export interface ScenarioInput {
  blocks: InputBlock[];
  source: string;
}

const HEADING = /^#{1,6}\s+(.+)$/;
const LIST_ITEM = /^(?:[-*•]|\d+[.)]|step\s+\d+\s*[:.)-])\s+(.+)$/i;
const EXPECTED = /^expect(?:ed)?(?:\s+results?)?\s*[:\-–]\s*(.+)$/i;

/** Classifies one line or paragraph. A bullet before "Expected:" still makes an expect block. */
function textBlock(text: string, listItem: boolean): InputBlock {
  const item = text.match(LIST_ITEM)?.[1];
  const expected = (item ?? text).match(EXPECTED)?.[1];
  if (expected) return { kind: "expect", text: expected.trim() };
  if (item) return { kind: "item", text: item.trim() };
  return { kind: listItem ? "item" : "paragraph", text };
}

function textBlocks(text: string): InputBlock[] {
  const blocks: InputBlock[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push(textBlock(paragraph.join(" "), false));
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
    const heading = line.match(HEADING)?.[1];
    if (!line) endParagraph();
    else if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", text: heading.trim() });
    } else if (LIST_ITEM.test(line) || EXPECTED.test(line)) {
      endParagraph();
      blocks.push(textBlock(line, false));
    } else paragraph.push(line);
  }
  endParagraph();
  return blocks;
}

function decodeXml(value: string) {
  return value
    .replace(/<w:tab\s*\/?>/g, "\t")
    .replace(/<w:br\s*\/?>/g, "\n")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function wordText(xml: string) {
  return decodeXml(xml.replace(/<w:t[^>]*>(.*?)<\/w:t>/gs, "$1").replace(/<[^>]+>/g, "")).trim();
}

async function docxBlocks(data: Buffer): Promise<InputBlock[]> {
  const zip = await JSZip.loadAsync(data);
  const document = await zip.file("word/document.xml")?.async("string");
  if (!document) throw new Error("The DOCX file has no word/document.xml part.");

  const blocks: InputBlock[] = [];
  const body = document.match(/<w:body[\s\S]*<\/w:body>/)?.[0] ?? document;
  for (const block of body.match(/<w:tbl[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    if (block.startsWith("<w:tbl")) {
      const rows = (block.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? [])
        .map((row) => (row.match(/<w:tc[\s\S]*?<\/w:tc>/g) ?? []).map(wordText))
        .filter((cells) => cells.some(Boolean));
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }
    const text = wordText(block);
    if (!text) continue;
    const style = block.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
    if (/^(heading\s*\d|title)$/i.test(style)) blocks.push({ kind: "heading", text });
    else blocks.push(textBlock(text, block.includes("<w:numPr>")));
  }
  return blocks;
}

export async function readScenarioInput(options: { file?: string; stdin?: string }): Promise<ScenarioInput> {
  if (options.file) {
    const extension = options.file.toLowerCase().split(".").pop();
    const data = await readFile(options.file);
    if (extension === "txt") return { blocks: textBlocks(data.toString("utf8")), source: options.file };
    if (extension === "docx") return { blocks: await docxBlocks(data), source: options.file };
    throw new Error("Scenario input must be a .txt or .docx file.");
  }

  const blocks = textBlocks(options.stdin ?? "");
  if (blocks.length === 0) throw new Error("Scenario instructions cannot be empty.");
  return { blocks, source: "stdin" };
}
