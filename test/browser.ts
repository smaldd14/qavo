import { afterAll, beforeAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { serveFixtures } from "./serve.ts";

/** Starts the fixture server and one headless browser for a test file. Each call to open() makes a new page. */
export function useFixtureBrowser() {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof serveFixtures>>;
  const pages: Page[] = [];

  beforeAll(async () => {
    server = await serveFixtures();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  return {
    baseUrl: () => server.url,
    async open(fixture: string) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
      pages.push(page);
      await page.goto(`${server.url}/${fixture}`);
      return page;
    },
  };
}
