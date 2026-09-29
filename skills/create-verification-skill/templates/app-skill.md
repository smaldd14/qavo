---
name: verify-{{app}}
description: Verify changes to {{App name}} in the running app. Use after you change {{App name}} UI, API, or data code, before you say that the change works, and to reproduce a {{App name}} bug. It starts the dev environment, logs in as a test user, finds the affected features in the feature map, and drives them with qavo browser.
---

# Verify {{App name}}

Use this skill to prove that a change works in the running app, not only in tests. Use the `qavo-browser` skill for the browser commands. This skill says what to check in {{App name}} and how to get there.

## 1. Bring up the app

Follow [references/dev-environment.md](references/dev-environment.md). It has the commands to install, seed, start, and check the app, and how to log in. Start only what is not already running.

## 2. Find the features that the change touches

1. List the changed files: `git diff --name-only {{base branch}}...HEAD`, plus the uncommitted files.
2. Open [references/features/README.md](references/features/README.md). Find each feature whose `Code` paths match a changed file.
3. If no feature matches, find the closest feature by the page or the API that the change touches. Tell the user that the feature map has no entry for it.

## 3. Check the feature file before you trust it

Each feature file has `verified` with a commit. Run:

```sh
git log --oneline <verified commit>..HEAD -- <the feature's Code paths>
```

If there are commits other than the change that you verify, the steps can be out of date. Follow them, and fix the feature file where the app now differs (step 6).

## 4. Verify

For each affected feature:

1. Plan the check: the steps from the feature file that exercise the change, and what must be true at the end. Add a check for the exact behavior that the change adds or fixes.
2. Drive it with `qavo browser`, with `--name {{app}}-<branch>`. Follow the `qavo-browser` skill loop.
3. After each action, read `changes`, `network.failed`, and `console.errors`. Confirm the key API call with `qavo browser network <id>`.
4. Also run the feature's "Regression checks" that the change could break.

Do not use `eval` to do a step. Use it only to read state that the UI does not show.

## 5. Report

For each feature: works, does not work, or could not verify (and why). Give the evidence: the text lines, the key request with its status, console errors, and the screenshot path. Say which feature files you changed.

## 6. Keep the map current

The feature map is part of the code. Update it in the same change:

- A step, a name, or a route in a feature file does not match the app: fix the file.
- The change adds a feature or a page: add a feature file from [references/features/_template.md](references/features/_template.md), and add it to the map.
- You drove a feature from start to end and it matched: set its `verified` to today's date and the current commit (`git rev-parse --short HEAD`).
- A gotcha cost you time: add it under "Gotchas".

Do not copy credentials, customer data, or tokens into these files. Use environment variable names.

## Sources

The manual test steps came from the team documents in [references/sources.md](references/sources.md). The feature files are the source of truth for agents. If a feature file and its source document disagree, tell the user. Do not change the file to match an old document without asking.
