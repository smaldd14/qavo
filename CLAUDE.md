# qavo rules

Read `CONTEXT.md` for the terms. Read `docs/plan.md` for the current iteration.

## Architecture rules

- Code owns the loop. A model never chooses what code runs next except through a typed choice from options that code offered.
- All model output goes through zod before use. A choice must be one of the offered labels. Probabilities must be finite numbers from 0 to 1.
- When a text model must return a JSON shape, send `response_format: json_schema` with `strict: true`, made with `z.toJSONSchema` from the same zod schema that parses the reply. Do not use `json_object` and a prose list of keys. Do not add code that maps key aliases (`goal`, `name`, `setup`) to the real keys. The model invents a new alias on each run.
- Check each new model prompt with at least 3 live calls before you call it done. Stubbed-model tests only prove the shapes that we wrote ourselves. Record the latency, and set the timeout well above it.
- Use only the target head for the chosen operation. Ignore the other heads.
- Act only through the stored node reference from the snapshot. Never build a CSS selector from model output.
- Check the guards (fingerprint, visible, enabled, not covered, allowed host) before each action.
- `TYPE_TEXT` is only for editable roles (`textbox`, `searchbox`, `spinbutton`, editable `combobox`). Never offer it for a checkbox, radio, or switch.

## Agent CLI (`qavo browser`)

- The driver holds no model. The agent that calls it is the model, so the rules above apply at the command line: actions take a snapshot index and pass the guards. Do not add a command that acts through a selector or a screen position (`click-xy`).
- `eval` is for reading. It must never update the fingerprint that actions check, and its result must report `pageChanged`. Do not add an option that makes `eval` count as an action.
- Each command prints one JSON object. A new error needs a `code` and a `hint` that names the command to run instead.
- `qavo browser` must not import the Jev runner or load `playwright-core` outside the driver process. Each command should start in about 300 ms.
- A change to the driver needs a test in `test/driver.test.ts` that runs the real binary.
- People on other machines use `qavo browser` with no other help than `skills/qavo-browser/`. A change to a command, an option, an output field, or an error code must update `SKILL.md` or `reference.md` in the same commit. `test/docs.test.ts` checks the command and error names.
- Users install with `npm install -g github:smaldd14/qavo`, not from a checkout. A change to `bin/`, `package.json`, or a file path must pass a clean install: `npm pack`, then `npm install -g --prefix <temp dir> <tarball>`, then a `start`, `snapshot`, and `stop` with that binary.

## Credentials

- Credentials never reach a model. Password field values come only from `step.data`, and the report writes `***` for them.
- Never send `storageState` files, cookies, or tokens to a model.
- `qavo browser` output is read by a model. Never print a typed value, a password value, or an `--env` value. New output that holds page or network data (`network`, `console`, `eval`) must go through the observer's `redact`.
- `network` never prints request or response headers. They hold cookies and tokens.

## Public repo

- This repo is public. It must hold no pm-agent data: no scenarios, screenshots, traces, reports, or credentials from pm-agent.
- pm-agent scenarios live in the pm-agent repo under `qa/`. Run output lives in `.qavo/`, which git ignores.
- Before each push, run `git status` and check that no `.env`, `.qavo/`, or pm-agent file is staged.

## Checks

- `pnpm test` runs offline. Tests use `test/fixtures/*.html` and a stubbed Jev client.
- `pnpm typecheck` and `pnpm knip` must be clean before a commit.
- Static fixtures draw the page before `goto` returns. Real apps do not: React draws after load, then shows a skeleton while it fetches data. `test/fixtures/spa.html` copies this (empty root, skeleton, then a 400 ms fetch). A change to the loop, the snapshot, or the waits needs a test on `spa.html`, not only on static fixtures.
- An iteration is not done until one run passes against a real app (pm-agent locally). Fixture tests alone missed the first-snapshot bug.
- When a real-app run finds a qavo problem, add a fixture that copies the app's behavior, and a test that fails before the fix. The pm-agent run for `qavo browser` found five such problems that static fixtures hid: hundreds of dev-server module requests (`assets.html`), an error overlay in a shadow root (`overlay.html`), queries that React cancels, a switch whose state is not in the page text, and an overlay that changed the controls but not the fingerprint.
