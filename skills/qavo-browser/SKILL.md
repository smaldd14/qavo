---
name: qavo-browser
description: Verify a web UI change in the running app with the `qavo browser` CLI. It drives a real Chromium page one command at a time, acts by snapshot index, and returns JSON. Use it after you change frontend or full-stack code and need to prove that the change works in the browser, to reproduce a UI bug, or to collect a screenshot as evidence. Needs the app to run locally and `qavo` on the PATH.
---

# Verify a change with qavo browser

`qavo browser` gives you hands in a real browser. You are the reasoning; qavo has no model inside. You read the page with `snapshot`, act on an element by its `index`, and read what changed. Each command prints one JSON object.

Full reference (every field, guard, and error code): [reference.md](reference.md).

## Before you start

1. Run `qavo browser doctor`. If `qavo` is not found, stop and tell the user to install it: `npm install -g github:smaldd14/qavo`. If a check fails, run the command in its `fix`.
2. Make sure the app runs. Find the dev server URL in the project (for example `package.json` scripts or the README). If it does not run, start it in the background, or ask the user.
3. If the page needs a login, look for a saved session in `~/.qavo/sessions/` (the name is the encoded host, for example `localhost%3A5173.json`) or in `qavo.config.ts`. If there is none, ask the user to run `qavo login <url>` in their terminal. You cannot run it: it needs a human to log in. Never read or print the session file.

## The loop

```sh
qavo browser start http://localhost:5173/work-orders --name <task>   # add --storage-state <file> if needed
qavo browser snapshot --name <task>
qavo browser type 4 "125.50" --name <task>
qavo browser click 7 --name <task>
qavo browser screenshot /tmp/<task>-after.png --name <task>
qavo browser stop --name <task>
```

Use a `--name` for your task (for example the branch name) so that you do not take over another agent's browser. You can also `export QAVO_DRIVER=<task>` once.

1. **Plan the check.** Before you start, write down what the user would do and what the page must show when the change works. Check the result that the change is about, not only that no error appeared.
2. **Start** the driver on the page that the change touches.
3. **Snapshot.** Read `text` and `elements`. Pick the element by `role`, `name`, and `context`. Never guess an index; take it from the latest snapshot.
4. **Act** with `click`, `type`, `select`, or `press`. Read the result:
   - `changes.added` and `changes.removed` show which text lines the action changed. Use them to confirm the effect.
   - `pageChanged: false` means that the action did nothing visible. Take a snapshot and think again. Do not repeat the same action more than once.
5. **Snapshot again** when you need an element that was not in the last snapshot, after a navigation, or after a `refused` error.
6. **Collect evidence.** Take a `screenshot` of the final state. Quote the relevant `text` lines.
7. **Stop** the driver when you are done, also after a failure.

## Rules

- Act only by snapshot index. There is no selector or JavaScript command, on purpose.
- If an action returns `ok: false`, read `error.hint` and do what it says. For `refused` with `reason: "stale"`, take a new snapshot. Do not retry the old index.
- Read the state before you toggle: a switch with `checked: true` is already on.
- Two elements can have the same name (for example "Edit" in each table row). Use `context` to pick the right one.
- For a password or other secret, use `type <index> --env NAME`. Never put a secret in a command line. Ask the user for the variable name if you do not know it.
- If an element that you expect is missing, check `omitted`, try `scroll down` and `snapshot`, and check for a closed menu or tab.
- `qavo browser` cannot upload files, hover, drag, use iframes, or follow a new tab. If the check needs one of these, tell the user that you could not verify that part.

## Report to the user

Say what you checked, the steps you took, and the result: works, does not work, or could not verify. Give the evidence: the `changes` lines or `text` lines that prove it, and the screenshot path. If the check failed, say what the page showed instead.
