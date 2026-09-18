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

### Later (only when Stage 0 data shows a need)
HTML report, Playwright test export for passed runs, the Claude rescuer, a planner from a PR, a login for each role, context providers, and CI `check-pr`.

## Verification
- `pnpm test` runs offline: fixture snapshots, guards, the stubbed Jev, and the scripted loop.
- `pnpm typecheck` and `pnpm knip` are clean.
- Live check: `pnpm qavo run examples/fixture-hotel.json --headed` passes and writes `report.json`.
- Before each push: `git status` shows no `.env`, `.qavo/`, or pm-agent files.
