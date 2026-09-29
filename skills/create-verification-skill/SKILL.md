---
name: create-verification-skill
description: Create a verification skill for a web app repo, so that coding agents can prove their changes in the running app with qavo browser. It records how to bring up the dev environment and log in, imports the team's manual test steps (Confluence, SharePoint, Google Docs, or files), builds a feature map with qavo browser steps for each feature, and writes a verify-<app> skill that keeps the map current. Use when the user asks to create, set up, or refresh a verification skill or feature map for a project.
---

# Create a verification skill

You write a skill named `verify-<app>` into the user's repo. Later agents use it to prove a change in the running app. It has three parts:

1. **Dev environment:** exact commands to install, seed, start, and log in.
2. **Feature map:** each feature, how a user reaches it, how to drive it with `qavo browser`, what to check, and the gotchas.
3. **Rules to keep it current:** each verification updates the map in the same change.

Do the work in the phases below, in order. Each phase ends with something that you ran, not only read. Tell the user at the end of each phase what you found and what you still need.

Templates for each file are in [templates/](templates/). Copy them and replace each `{{...}}`. Delete sections that do not apply; do not leave a placeholder.

## Phase 0: Check the tools

1. Run `qavo browser doctor`. If `qavo` is not found, ask the user to install it: `npm install -g github:smaldd14/qavo`. Fix each failed check with its `fix`.
2. Read the `qavo-browser` skill if it is not already loaded. You use its loop in phases 4 and 5.
3. Ask the user which coding agents the team uses. This decides where the skill goes:

| Agent | Skill directory |
| --- | --- |
| Claude Code | `.claude/skills/verify-<app>/` |
| Cursor | `.cursor/skills/verify-<app>/` |
| Other agents (Codex, Copilot, and more) | The skill directory that the agent's documentation names, for example `.agents/skills/verify-<app>/`. Also add a line to `AGENTS.md` that points to its `SKILL.md`, because every agent reads that file. |

If the team uses more than one agent, write the skill once in the first directory, and point the others to it (a line in `AGENTS.md` or a symbolic link). Do not keep two copies.

If a `verify-<app>` skill already exists, this is a refresh. Read it first, keep what is still true, and go to the phase that the user asks for.

## Phase 1: Learn how the app runs

Read, do not guess. Look at the README, `CONTRIBUTING.md`, `package.json` scripts (or `Makefile`, `justfile`, `docker-compose.yml`, `Procfile`), `.env.example`, CI workflow files, and seed or fixture scripts. Find:

- The runtime and its version, and the install command.
- How to start the app and its services (database, API, workers), the ports, and how to tell that it is ready.
- How to seed or reset data, and which records the seed creates.
- How users log in: a login form, SSO, a magic link, or a dev bypass. Which test users and roles exist.
- Feature flags, and external services (payments, email, storage) with their test modes or stubs.
- The hosts that the browser must reach. These become `allowHosts`.

Ask the user only for what the repo does not tell you. Credentials come from the user or the team's password manager. Record only the names of the environment variables that hold them, never the values.

## Phase 2: Bring it up and log in

1. Run the install, seed, and start commands. Fix what fails, and record the fix.
2. Check that it is ready with the check that you found.
3. Log in with `qavo browser`:
   - Login form: `type` the email, `type <index> --env <PASSWORD_VARIABLE>` for the password, then `click` sign in.
   - SSO, a magic link, or 2FA: ask the user to run `qavo login <url> --out ~/.qavo/sessions/<app>-<role>.json` in their terminal. You cannot do it; it needs a human. Then use `--storage-state` with that file.
4. Take a snapshot and confirm that you are logged in. Check `network --failed` and `console --level error`: note the errors that are there before any change.
5. If the app has fixed hosts and a session file, suggest a `qavo.config.ts` in the repo root with `url`, `allowHosts`, and `storageState`, so that `qavo browser start /path` works.

Write `references/dev-environment.md` from [templates/dev-environment.md](templates/dev-environment.md) with the commands that worked. Include how long start takes.

## Phase 3: Import the team's manual steps

Ask the user where the team's manual verification or QA steps are: Confluence, SharePoint, Google Docs, Notion, a test management tool, or files. Get them in this order of preference:

1. **A connector in this session** (for example an Atlassian, Microsoft 365, Google Drive, or Notion MCP server). Read the pages with it. Record each page's URL and its version or last-modified date.
2. **Files that the user exports** (`.docx`, `.pdf`, `.md`, `.html`) into a folder outside the repo, or into a folder that git ignores. Read them from there. `qavo scenario new --from <file.docx>` can also turn numbered steps into `qavo run` scenarios, if the team wants scheduled regression runs.
3. **Pasted text** in the chat.

Then distill, do not copy:

- Keep the steps, the expected results, the roles, and the data that they need. Rewrite each step as the user action and the thing to check.
- Leave out credentials, customer data, personal data, internal hostnames that are not part of the dev environment, and screenshots. Replace a credential with an environment variable name.
- Put each step with the feature that it tests. One document can feed several feature files.
- If a document disagrees with the app that is running, trust the app, and note the difference for the user.

Do not commit the raw documents. Commit only the distilled feature files and `references/sources.md` (from [templates/sources.md](templates/sources.md)), which records where each step came from and which version you read.

Why in the repo, and not fetched each time: the agent that verifies a change may have no connector or no access to the documents; the steps then change with the code in the same pull request, and a reviewer sees them; and the manual documents have prose, screenshots, and old steps that cost context and mislead. `sources.md` keeps the link to the original, so a person can refresh the files.

## Phase 4: Build the feature map

1. List the features. Use the app's navigation and routes (the router file, the pages directory, or the API routes), the imported documents, and what you see with `qavo browser`. Name each feature as a user would.
2. For each feature, write `references/features/<feature>.md` from [templates/feature.md](templates/feature.md):
   - `code`: the paths (globs) that implement it. The verify skill uses them to find the features that a diff touches, and to find stale files.
   - "How to get to it" from the user's view, and "Drive it with qavo browser" with real commands. Name elements by role and name, never by index. Indices change.
   - "What to check": the page text, the API call with its method and status, and no errors.
   - "Gotchas": what surprised you while you drove it.
3. Write `references/features/README.md` from [templates/features-README.md](templates/features-README.md): one row for each feature, the journeys that cross features, and the areas that are not in the map.
4. Copy [templates/feature.md](templates/feature.md) to `references/features/_template.md`, so that later agents add features in the same form.

Start with the features that change most or that the documents cover best. A map with 8 correct features is better than 40 guesses. List the rest under "Not in the map".

## Phase 5: Drive each feature

For each feature file, drive its "Drive it with qavo browser" steps from start to end, in a fresh driver (`--name verify-setup`):

- If a step fails, fix the file, not the app. Record the gotcha.
- If it matches, set `verified` to today's date and the commit (`git rev-parse --short HEAD`).
- If you cannot drive it (a missing role, hardware, an external service without a test mode), set `verified: not yet` and say why in the map.

Stop the driver when you are done.

## Phase 6: Write the verify skill

Write `SKILL.md` from [templates/app-skill.md](templates/app-skill.md) into the skill directory from phase 0, next to `references/`:

```
verify-<app>/
  SKILL.md
  references/
    dev-environment.md
    sources.md
    features/
      README.md
      _template.md
      <feature>.md ...
```

- Set the `description` so that an agent loads it at the right time: name the app, and say "after you change UI, API, or data code, before you say that the change works".
- Set the base branch in step 2 of the template.
- If the team uses `AGENTS.md`, add one line: "To verify a change in the running app, follow `<path>/verify-<app>/SKILL.md`."

## Phase 7: Test the skill, then hand it over

1. Pick one feature and pretend that a change touched one of its `code` paths. Follow the new `SKILL.md` from step 1, as a new agent would. Fix each place where you had to guess.
2. Check that no file has a credential, a token, customer data, or a leftover `{{`: `grep -rn "{{" <skill directory>`.
3. Show the user the file tree, the features that are verified and not verified, and the questions that are still open.
4. Suggest one commit with the skill and, if you wrote one, `qavo.config.ts`. Do not commit session files or `.env`.
