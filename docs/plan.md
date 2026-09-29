# qavo: iterative build plan for the v0 Jev driver

## Context

The design doc "QA Agent Design (Exploratory)" has a v0 section. v0 is one Jev loop with no Claude calls:

snapshot → one Jev request (operation + one target head for each operation) → act → repeat until DONE, then a Jev yes/no check of `step.expect`. The result is `pass`, `fail`, `blocked`, or `unclear`, and the run writes `report.json` with screenshots.

A goal is a scenario with one step. A step doc is a scenario with many steps. Each typed value comes from `step.data`, or from a small text model when the step has no value. Each value is recorded with its source. The reference implementation is `browser-use/jev-ultrafast` (Python). We port its ideas to TypeScript. We do not copy its Python.

Decisions:

- Repo: `smaldd14/qavo`, public, MIT license.
- Browser: `playwright-core` with our own in-page snapshot script.
- Runtime: Node 24, pnpm, TypeScript, Vitest.
- Jev: `@typesafe-ai/sdk@0.6.0` (`TypeSafeClient.systemOne`, `choice`, `noul`).
- The first target app is a private app (pm-agent: Vite + Supabase auth).

**Public repo rule:** qavo must hold no pm-agent data. Do not commit pm-agent scenarios, screenshots, traces, or credentials. Those stay in pm-agent (`qa/`) or in the ignored `.qavo/` folder.

## Iterations

Each iteration ends with a commit to `main`, passing `pnpm test`, and one visible result.

### 0. Repo scaffold
- `package.json` (type module, `bin: qavo`), strict `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, MIT `LICENSE`.
- Docs: `README.md`, `CONTEXT.md`, `CLAUDE.md`, and this plan.
- **Done when:** the repo is public on GitHub and `pnpm test` runs (0 tests).

### 1. Snapshot
- `src/browser/snapshot.ts` runs an in-page function through `page.evaluate`. It reads visible, enabled controls in one call: index, role, accessible name, value, checked/selected/expanded, and allowed operations (`CLICK`, `TYPE_TEXT`, `SELECT` with options). It also returns the visible page text (capped) and a fingerprint (URL + form values + control list).
- Keep live node references in a page-side `Map` by index. This avoids selectors.
- Use editable roles only for `TYPE_TEXT`, so that checkboxes are not typed into.
- `test/fixtures/*.html`: a form, a combobox with suggestions, a table with row buttons, a modal, and hidden and disabled controls.
- **Done when:** fixture tests show the correct elements and operations, and hidden or disabled controls are not in the list.

### 2. Jev decision
- `src/jev/decide.ts` builds one `systemOne` request: one `operation` choice and one `<op>_target` choice for each operation that has candidates. State is page (URL, title, text), elements, the step intent, and the last 10 actions.
- `src/jev/prompts.ts` holds the operation and target rules.
- Validate the answer with zod. Use only the target head for the chosen operation.
- `scripts/decide-fixture.ts` runs one live decision against a fixture page.
- **Done when:** unit tests with a stubbed client pass, and one live decision on the fixture selects the expected element.

### 3. Act with guards
- `src/browser/act.ts`: click, type (select-all, then `keyboard.insertText`), select, scroll, and wait, all through the stored node reference.
- Before each action, check freshness, visibility, the enabled state, and occlusion. Refuse a URL that is not in `allowHosts`.
- After an action, wait up to 2 animation frames or 50 ms. For a combobox, wait up to 200 ms for suggestions.
- **Done when:** fixture tests cover a covered button (refused), a stale page (refused), text replacement, a native select, and combobox suggestions.

### 4. Loop, values, and CLI
- `src/scenario.ts`: zod `Scenario` and `Step`, and the `qavo.config.ts` shape.
- `src/values.ts`: for `TYPE_TEXT`, Jev chooses a `data_key` from `step.data` (plus `none`). With `none`, the text model writes the value. Password fields are never sent to a model. Record the source of each value.
- `src/run.ts`: the step loop. `unclear` when confidence is below the threshold. `expect` check with `noul` after `DONE`. Action and time limits.
- `src/report.ts`: `.qavo/runs/<id>/report.json` and a screenshot after each action.
- `src/cli.ts`: `qavo run <scenario.json> [--headed]`.
- **Done when:** an offline test with a scripted fake Jev passes a 3-step fixture scenario and a 1-step goal, and a live run passes the fixture hotel-search goal.

### 5. Login with a real role
- `qavo login <url> --out .qavo/<role>.json` opens a headed browser. You log in by hand, and qavo saves `storageState`. `run` loads that file.
- **Done when:** a run against local pm-agent starts already logged in.

### 6. Stage 0 on pm-agent
- In pm-agent (private repo), add `qavo.config.ts` and `qa/scenarios/` with 5 to 10 real goals and step docs.
- Run each scenario 3 times. Label each Jev decision as correct or wrong. Record operation accuracy, target accuracy, the `unclear` rate, latency, and cost.
- Set the confidence threshold from that data.
- **Done when:** the design doc has the Stage 0 numbers, and 5 pm-agent scenarios pass with no Claude call.

### 7. Scenario authoring
- `qavo scenario new` asks for the start URL first, then reads stdin, `.txt`, or `.docx` input. Code builds drafts from headings, list items, `Expected:` lines, and table rows. No model is called.
- Drafts copy the input text word for word, show text that did not become a step, and support edit, approve, or cancel.
- Approval writes one scenario JSON file per draft in the current directory, or in `--out` when provided.
- Data keys become `@env:NAME` references after the user supplies environment variable names. The command never resolves or runs them.
- **Done when:** offline tests cover extraction, draft building, confirmation, secret references, file collisions, and the CLI writes no run artifacts. A scenario written by the command passes against pm-agent.

### 8. Agent CLI (`qavo browser`)
A coding agent (Claude Code, Cursor) verifies its own change in the running app. The agent is the reasoning. qavo is the hands: a CLI with no model inside. The Jev loop stays as the cheap runner for saved scenarios.

- A driver process owns one browser page between commands. `qavo browser start <url>` spawns it; other commands talk to it over a Unix socket in `~/.qavo/drivers/<name>/` (mode 0700). `--name` keeps parallel checkouts apart. The driver stops after 30 idle minutes.
- Commands: `start`, `stop`, `status`, `doctor`, `open`, `snapshot`, `click`, `type`, `select`, `press`, `scroll`, `wait-settle`, `screenshot`.
- Output is one JSON object on stdout. An error has a `code`, a `message`, and a `hint` that says what to run instead. `--help` on each command has examples.
- Actions take a snapshot index, never a selector. They check the same guards as the Jev loop against the fingerprint of the last snapshot (or `--fp`). `--dry-run` runs the guards and names the target without input.
- A password field accepts text only from `--env NAME`. Output never echoes typed text.
- Other people install it with `npm install -g github:smaldd14/qavo`, with no build step. `bin/qavo.js` refuses Node older than 24 with a clear error.
- The skill `skills/qavo-browser/` (`SKILL.md` and `reference.md`) is how an agent on another machine learns the tool. The repo is also a Claude Code plugin marketplace, so `/plugin install qavo@qavo` installs the skill.
- **Done when:** an offline test drives `spa.html` through the real binary (start, snapshot after the skeleton, type, click, a stale refusal, screenshot, stop), a clean `npm install -g` from the tarball runs a session, the plugin installs the skill, and an agent verifies one change in pm-agent with only `qavo browser`.

### 9. See the network and the console; read with eval
A verification is not done when the page only looks right. The save can return 500, or the page can throw.

- The driver records each request (method, URL, type, status, failure, time) and each console message and uncaught page error, with one id sequence. It keeps the last 500 of each.
- Each action result and `open` add a `network` summary (app requests, failed requests) and a `console` summary (errors, warnings, the first errors).
- `network [id]` lists requests (`--failed`, `--filter`, `--all`, `--last-action`, `--since`) or shows one with its bodies. Headers are never shown.
- `console` lists messages by level. Chromium's own "Failed to load resource" errors are left out, because `network` has them.
- `eval <expression>` reads page state as JSON. It is not an action: no guards, no fingerprint update, and `pageChanged` with a warning when it changed the page. There is no `click-xy`.
- Each `--env` value is replaced by `***` in all of this output.
- **Done when:** an offline test on `api.html` shows a 500 and a console error in an action result, a body in `network <id>` with the password hidden, a page error in `console`, and an eval that changes the page followed by a stale refusal.

### Later (only when Stage 0 data shows a need)
HTML report, Playwright test export for passed runs, the Claude rescuer, a planner from a PR, a login for each role, context providers, and CI `check-pr`.

## Verification
- `pnpm test` runs offline: fixture snapshots, guards, the stubbed Jev, and the scripted loop.
- `pnpm typecheck` and `pnpm knip` are clean.
- Live check: `pnpm qavo run examples/fixture-hotel.json --headed` passes and writes `report.json`.
- Before each push: `git status` shows no `.env`, `.qavo/`, or pm-agent files.
