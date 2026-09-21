# qavo

qavo is a QA agent for web apps. It reads a scenario in plain language, drives a real browser, and reports `pass`, `fail`, `blocked`, or `unclear` with evidence.

qavo v0 uses no large reasoning model. Each browser step is one typed choice from [Jev](https://docs.typesafe.ai) (TypeSafe System One). Code owns the loop. The model only picks from the options that code offers.

## The v0 loop

For each step in a scenario:

1. **Snapshot.** One in-page script reads the visible, enabled controls, the page text, and a fingerprint.
2. **Decide.** One Jev request asks for the next operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `WAIT`, `SCROLL_DOWN`, `SCROLL_UP`, `DONE`, `BLOCKED`) and, in parallel, one target for each operation. Code uses only the target for the chosen operation.
3. **Act.** Code checks that the page did not change, that the target is visible, enabled, and not covered, then acts on the stored node.
4. **Repeat** until `DONE` or `BLOCKED`, or until a limit stops the step.
5. **Check.** After `DONE`, one Jev yes/no question checks the step's `expect` against the page.

A typed value comes from `step.data` when Jev finds a matching key. Otherwise a small text model writes it. The report records the source of each value. Password fields never go to a model.

Each run writes `report.json` and screenshots to a private temporary directory outside the checkout by default. The CLI prints the report path. Reports contain the exact decision requests and page-change evidence.

## Use

```sh
pnpm install
pnpm exec playwright-core install chromium
cp .env.example .env   # add TYPESAFE_API_KEY, and a text model key if steps need generated values
pnpm fixtures          # in a second terminal: serves test/fixtures on http://127.0.0.1:4173
pnpm qavo run examples/fixture-hotel.json --headed
```

To run as a logged-in user, save a session once, then point `qavo.config.ts` (or `--storage-state`) at it:

```sh
pnpm qavo login http://localhost:5173
```

Login saves a private session file to `~/.qavo/sessions/<encoded-host>.json`. The host includes its port; `localhost:5173` becomes `localhost%3A5173.json`. Use `--out` for separate role files. Login replaces an existing session at that path.

Session paths accept `~/` in `--out`, `--storage-state`, and config `storageState`. Runs do not load saved sessions automatically.

`qavo run` looks for `qavo.config.ts` in the scenario's folder and its parents. Configuration does not determine the output directory:

```ts
export default {
  url: "http://localhost:5173",   // scenario URLs can be paths, for example "/work-orders"
  storageState: "~/.qavo/sessions/localhost%3A5173.json",
  allowHosts: ["localhost:5173", "127.0.0.1:54321"],
  limits: { confidence: 0.5, expectPass: 0.7, expectFail: 0.3, stepSeconds: 120 },
};
```

A scenario is JSON:

```json
{
  "name": "Find a free-cancellation stay in Lisbon",
  "url": "http://127.0.0.1:4173/hotel.html",
  "steps": [
    {
      "intent": "Search for stays in Lisbon with free cancellation",
      "data": { "destination": "Lisbon" },
      "expect": "Only Lisbon stays with free cancellation are listed"
    }
  ]
}
```

A goal is a scenario with one step. A step doc is a scenario with many steps.

## Environment data

Use an exact reference in `step.data`, such as `"password": "@env:QA_PASSWORD"`. Supply the variable through your environment or CI secret store. Missing variables and malformed references fail before the browser starts. Literal values still work. References do not expand inside larger strings or recursively.

All env-resolved values are sensitive, including values entered into non-password fields. Reports and action history use `***`. Model requests and reports also replace known secret text and its URL-encoded form. This replacement does not recognize arbitrary application transformations of a secret.

Runs with env references omit screenshots because the application can display secrets anywhere on the page. Runs without env references retain screenshots. Keep all reports private.

## Artifact output

Use `qavo run scenario.json --out /absolute/artifact-directory` for a persistent local destination. Each run creates `runs/<id>/` there. Without `--out`, the operating system can remove the temporary files later.

For R2 uploads, set these environment variables through your CI secret store:

| Variable | Value |
| --- | --- |
| `QAVO_S3_ENDPOINT` | The HTTPS S3 endpoint from your R2 account |
| `QAVO_S3_BUCKET` | An existing private bucket |
| `AWS_ACCESS_KEY_ID` | The bucket-scoped access key ID |
| `AWS_SECRET_ACCESS_KEY` | The secret access key |
| `QAVO_S3_REGION` | Optional; defaults to `auto` for R2 |
| `QAVO_S3_PREFIX` | Optional relative object prefix, such as `qa/build-123` |
| `AWS_SESSION_TOKEN` | Optional session token for compatible providers |

Uploads are disabled when no `QAVO_S3_*` variables are set. Other S3-compatible providers require their endpoint and region.

The CLI uploads only the report and its referenced screenshots. It uploads the report last and prints an `s3://` location. It does not create a bucket or change its access policy. Keep the destination private: reports and screenshots can contain application data.

Local files remain after either upload success or failure. An upload failure returns exit code `2` without changing the QA result in the report. Without an upload error, exit code `0` means `pass`; `1` means `fail`, `blocked`, or `unclear`.

## Status

v0 is in progress. See [docs/plan.md](docs/plan.md) for the iterations and [CONTEXT.md](CONTEXT.md) for the terms.

## Inspiration

qavo is inspired by [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). That project showed that a browser agent can run on typed Jev choices: one operation head, one target head for each operation, and a small text model for field values. qavo ports these ideas to TypeScript and adds scenarios, `expect` checks, and QA reports. qavo does not copy its code.

## License

MIT
