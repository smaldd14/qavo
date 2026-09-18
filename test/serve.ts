import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

/** Serves test/fixtures over HTTP on 127.0.0.1. Returns the base URL and a close function. */
export async function serveFixtures(port = 0) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = join(FIXTURES, path === "/" ? "index.html" : path);
    if (!file.startsWith(FIXTURES)) return response.writeHead(403).end();
    const body = await readFile(file).catch(() => null);
    if (!body) return response.writeHead(404).end("Not found");
    response.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actualPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
