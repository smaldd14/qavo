// Serves test/fixtures on http://127.0.0.1:4173 for the examples.
import { serveFixtures } from "../test/serve.ts";

const { url } = await serveFixtures(4173);
console.log(`Fixtures on ${url} (for example ${url}/hotel.html). Press Ctrl+C to stop.`);
