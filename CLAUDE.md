# qavo rules

Read `CONTEXT.md` for the terms. Read `docs/plan.md` for the current iteration.

## Architecture rules

- Code owns the loop. A model never chooses what code runs next except through a typed choice from options that code offered.
- All model output goes through zod before use. A choice must be one of the offered labels. Probabilities must be finite numbers from 0 to 1.
- Use only the target head for the chosen operation. Ignore the other heads.
- Act only through the stored node reference from the snapshot. Never build a CSS selector from model output.
- Check the guards (fingerprint, visible, enabled, not covered, allowed host) before each action.
- `TYPE_TEXT` is only for editable roles (`textbox`, `searchbox`, `spinbutton`, editable `combobox`). Never offer it for a checkbox, radio, or switch.

## Credentials

- Credentials never reach a model. Password field values come only from `step.data`, and the report writes `***` for them.
- Never send `storageState` files, cookies, or tokens to a model.

## Public repo

- This repo is public. It must hold no pm-agent data: no scenarios, screenshots, traces, reports, or credentials from pm-agent.
- pm-agent scenarios live in the pm-agent repo under `qa/`. Run output lives in `.qavo/`, which git ignores.
- Before each push, run `git status` and check that no `.env`, `.qavo/`, or pm-agent file is staged.

## Checks

- `pnpm test` runs offline. Tests use `test/fixtures/*.html` and a stubbed Jev client.
- `pnpm typecheck` and `pnpm knip` must be clean before a commit.
- Static fixtures draw the page before `goto` returns. Real apps do not: React draws after load, then shows a skeleton while it fetches data. `test/fixtures/spa.html` copies this (empty root, skeleton, then a 400 ms fetch). A change to the loop, the snapshot, or the waits needs a test on `spa.html`, not only on static fixtures.
- An iteration is not done until one run passes against a real app (pm-agent locally). Fixture tests alone missed the first-snapshot bug.
