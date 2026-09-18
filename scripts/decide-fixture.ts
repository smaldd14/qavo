// One live Jev decision against a fixture page.
// Usage: pnpm tsx scripts/decide-fixture.ts [fixture.html] [intent]
import { existsSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { chromium } from "playwright-core";
import { snapshot } from "../src/browser/snapshot.ts";
import { decide } from "../src/jev/decide.ts";
import { serveFixtures } from "../test/serve.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const [fixture = "form.html", intent = "Choose Billing as the topic of the message"] = process.argv.slice(2);
const server = await serveFixtures();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/${fixture}`);
  const state = await snapshot(page);
  const decision = await decide(new TypeSafeClient(), state, intent, []);
  console.log(JSON.stringify({ intent, ...decision }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
