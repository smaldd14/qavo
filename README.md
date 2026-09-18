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

Each run writes `.qavo/runs/<id>/report.json` and a screenshot after each action.

## Use

```sh
pnpm install
pnpm exec playwright-core install chromium
cp .env.example .env   # add TYPESAFE_API_KEY, and a text model key if steps need generated values
pnpm qavo run examples/fixture-hotel.json --headed
```

To run as a logged-in user, save a session once, then point `qavo.config.ts` (or `--storage-state`) at it:

```sh
pnpm qavo login http://localhost:5173 --out .qavo/admin.json
```

A scenario is JSON:

```json
{
  "name": "Find a free-cancellation stay in Lisbon",
  "url": "http://localhost:4173/hotel.html",
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

## Status

v0 is in progress. See [docs/plan.md](docs/plan.md) for the iterations and [CONTEXT.md](CONTEXT.md) for the terms.

## Inspiration

qavo is inspired by [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). That project showed that a browser agent can run on typed Jev choices: one operation head, one target head for each operation, and a small text model for field values. qavo ports these ideas to TypeScript and adds scenarios, `expect` checks, and QA reports. qavo does not copy its code.

## License

MIT
