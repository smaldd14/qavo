# qavo

qavo tests web apps in a real browser. It has two tools:

| Tool | Who decides | Use it to | Needs |
| --- | --- | --- | --- |
| `qavo browser` | A coding agent (Claude Code, Cursor, Codex) or a human | Check a change in the running app, one command at a time | Node 24 and Chromium. No API key. |
| `qavo run` | [Jev](https://docs.typesafe.ai) (TypeSafe System One) | Run saved scenarios in plain language and report `pass`, `fail`, `blocked`, or `unclear` | Node 24, Chromium, and a `TYPESAFE_API_KEY` |

The two tools share the same page reader and the same guards. Neither tool builds a CSS selector from model output. Each action goes through an element from a snapshot, and it is checked before the page gets any input.

## Install

qavo needs [Node 24](https://nodejs.org) or later. Install it from GitHub:

```sh
npm install -g github:smaldd14/qavo
qavo browser doctor
```

`doctor` checks Node, Chromium, and the driver. If the `chromium` check fails, run the command in its `fix`, then run `doctor` again. npm can show an `allow-scripts` warning for `esbuild`. You can ignore it; qavo does not need that script.

To update, run the same `npm install -g` command again. To remove qavo, run `npm uninstall -g qavo`.

## Use `qavo browser` from a coding agent

`qavo browser` gives a coding agent hands in a real browser. The agent does the reasoning, and no model runs inside qavo. A background driver keeps one page open between commands, so the agent can snapshot, act, and check the result step by step.

### Give your agent the skill

The skill tells an agent when to use `qavo browser`, how to run the loop, and how to report the result. It is in [`skills/qavo-browser/`](skills/qavo-browser/SKILL.md).

- **Claude Code.** Run these commands in Claude Code, then start a new session:

  ```
  /plugin marketplace add smaldd14/qavo
  /plugin install qavo@qavo
  ```

  From a terminal, use `claude plugin marketplace add smaldd14/qavo` and `claude plugin install qavo@qavo`.
- **Other agents.** Copy [`skills/qavo-browser/SKILL.md`](skills/qavo-browser/SKILL.md) (and [`skills/create-verification-skill/`](skills/create-verification-skill/SKILL.md) if you want it) into the agent's instructions, for example into `AGENTS.md` in your project. Tell the agent that the full reference is at <https://github.com/smaldd14/qavo/blob/main/skills/qavo-browser/reference.md>.

Then ask the agent to verify a change, for example: "Check in the browser that the Save button on /settings keeps the new email."

### Create a verification skill for your app

`qavo-browser` knows the browser, not your app. The plugin also has `create-verification-skill`, which writes a `verify-<app>` skill into your repo. Run it once in your app's repo, for example with `/qavo:create-verification-skill` in Claude Code. The agent:

1. Finds how to install, seed, start, and log in to your app, runs it, and records the commands that worked.
2. Imports your team's manual test steps from Confluence, SharePoint, Google Docs, or exported files. It keeps the steps, and it leaves out credentials and customer data.
3. Builds a feature map: one file for each feature, with how to reach it, the `qavo browser` steps, what to check, the code paths, and the gotchas.
4. Drives each feature to prove the steps, and marks it verified with a date and a commit.
5. Writes `verify-<app>/SKILL.md`, which later agents use to find the features that a diff touches, verify them, and update the map in the same change.

The team's documents stay where they are. The skill keeps distilled steps in the repo, with a link and a version for each source, so that an agent with no access to Confluence or SharePoint can still verify, and a reviewer sees step changes next to code changes.

### A session by hand

You can run the same commands yourself. Start your app, then:

```sh
qavo browser start http://localhost:5173/queue
qavo browser snapshot
```

```json
{"ok":true,"url":"http://localhost:5173/queue","title":"Queue",
 "text":"Opening balances\n2 left\n112 Automotive Blvd\nOwed at takeover\nSave and next",
 "elements":[{"index":2,"role":"textbox","name":"Owed at takeover","value":"0.00","operations":["TYPE_TEXT"]},
             {"index":3,"role":"button","name":"Save and next","operations":["CLICK"]}],
 "omitted":0,"scroll":{"y":0,"max":0},"fingerprint":"e396c9bf"}
```

Act on an element by its `index`. The result shows which lines of page text changed:

```sh
qavo browser type 2 "125.50"
qavo browser click 3
```

```json
{"ok":true,"target":{"index":3,"role":"button","name":"Save and next"},"pageChanged":true,
 "changes":{"removed":["2 left","112 Automotive Blvd"],"added":["1 left","21 Aberdeen Ave"]},
 "url":"http://localhost:5173/queue","title":"Queue","fingerprint":"669364f5","elements":3}
```

Each action result also has a `network` summary (the count of app requests and the failed ones) and a `console` summary (errors and warnings). For the details:

```sh
qavo browser network --last-action    # the requests that the click made, with status and time
qavo browser network 12               # one request with its request and response bodies
qavo browser console --level error    # console errors and uncaught exceptions
qavo browser eval "localStorage.getItem('theme')"   # read state that the snapshot does not show
```

Keep evidence, then close the browser:

```sh
qavo browser screenshot /tmp/after-save.png
qavo browser stop
```

Add `--headed` to `start` to watch the browser. `qavo browser --help` lists all commands, and `qavo browser <command> --help` shows the options and examples for one command.

### Log in

If the app needs a login, a human saves a session once:

```sh
qavo login http://localhost:5173
```

A browser opens. Log in, then press Enter in the terminal. qavo saves the session to `~/.qavo/sessions/<encoded-host>.json`, for example `~/.qavo/sessions/localhost%3A5173.json`. Then give the agent the path:

```sh
qavo browser start http://localhost:5173 --storage-state ~/.qavo/sessions/localhost%3A5173.json
```

An agent cannot run `qavo login`, because it needs a human to log in. The session file holds cookies and tokens. Keep it private, and do not commit it.

For a password field, the agent uses `qavo browser type <index> --env NAME`. The value comes from the shell environment or from `.env` in the current directory, so the secret never goes through the agent.

### Rules that qavo enforces

- Each command prints one JSON object. A failure is `{ "ok": false, "error": { "code", "message", "hint" } }` with exit code 1. The `hint` says what to run next.
- Actions take an element index from a snapshot, never a selector or a screen position.
- `eval` reads page state with a JavaScript expression. It is not an action: it passes no guards, and if it changes the page, the result says so and the next action needs a new snapshot.
- `network` never shows request or response headers. Bodies can hold application data, so keep the output private.
- Before each action, the driver checks that the page did not change since the last snapshot (the fingerprint), and that the target is visible, enabled, and not covered. `--dry-run` runs these checks with no input.
- The page can visit only the hosts in `allowHosts`. By default, this is the host of the start URL. Add more with `--allow-host`.
- A password field accepts text only from `--env NAME`. No output shows a typed value, and each `--env` value shows as `***` in `network`, `console`, and `eval` output.

### Several agents at once

Each driver has a name. The default name is `default`. Give each checkout or task its own name with `--name <name>` or `QAVO_DRIVER=<name>`, so that two agents do not share one page. The driver files are in `~/.qavo/drivers/<name>/`, which includes `driver.log`. Set `QAVO_HOME` to use a different root than `~/.qavo`. A driver stops after 30 minutes with no command.

### Configuration

`qavo browser start` reads `qavo.config.ts` from the current directory or a parent directory, if there is one. It uses the same file as `qavo run`, so a project can set the app URL, the login session, and the allowed hosts once:

```ts
export default {
  url: "http://localhost:5173",
  storageState: "~/.qavo/sessions/localhost%3A5173.json",
  allowHosts: ["localhost:5173", "127.0.0.1:54321"],
};
```

With this file, `qavo browser start /work-orders` opens `http://localhost:5173/work-orders` with the saved session.

### Reference and troubleshooting

[`skills/qavo-browser/reference.md`](skills/qavo-browser/reference.md) has every command, snapshot field, guard, and error code, and the current limits. Start with `qavo browser doctor` when something does not work.

| Problem | Fix |
| --- | --- |
| `qavo: command not found` | Run `npm install -g github:smaldd14/qavo`. Check that the npm global `bin` directory is on your `PATH`. |
| `node_version` | Install Node 24 or later. |
| `chromium` check fails in `doctor` | Run the command in its `fix`. |
| `start_failed` | Check that the app runs at the URL. Read `~/.qavo/drivers/<name>/driver.log`. |
| `path_too_long` | Set `QAVO_HOME` to a short directory, for example `export QAVO_HOME=/tmp/qavo`. |
| `already_running` | Use the driver, run `qavo browser stop`, or start another with `--name`. |

## Run scenarios with Jev (`qavo run`)

qavo v0 uses no large reasoning model for scenarios. Each browser step is one typed choice from Jev. Code owns the loop. The model only picks from the options that code offers.

### Setup

```sh
cp .env.example .env   # add TYPESAFE_API_KEY, and a text model key if steps need generated values
qavo run examples/fixture-hotel.json --headed
```

The example scenarios use the test fixtures. Serve them from a clone of this repo with `pnpm fixtures` (see [Develop qavo](#develop-qavo)).

### The v0 loop

For each step in a scenario:

1. **Wait.** Code waits until the page is quiet: no open fetch or XHR request, and the same controls and text for 250 ms (5 s maximum). An app that shows a skeleton while it loads data is read only after the data arrives.
2. **Snapshot.** One in-page script reads the visible, enabled controls, the page text, and a fingerprint.
3. **Decide.** One Jev request asks for the next operation and, in parallel, one target for each operation. Code uses only the target for the chosen operation.
4. **Act.** Code checks the guards, then acts on the stored node.
5. **Repeat** until `DONE` or `BLOCKED`, or until a limit stops the step.
6. **Check.** After `DONE`, one Jev yes/no question checks the step's `expect` against the page.

### What Jev decides

Jev returns typed choices and probabilities. It never writes code, selectors, or free text. Each run uses these questions:

| Question | Jev type | Answer |
| --- | --- | --- |
| Operation | Choice | One of `CLICK`, `TYPE_TEXT`, `SELECT`, `WAIT`, `SCROLL_DOWN`, `SCROLL_UP`, `DONE`, `BLOCKED`. Code offers only the operations that the page permits. |
| Target, one for each operation | Choice | One element index, or one `<index>:<option>` for `SELECT`. Code offers only elements that accept that operation. |
| Data key | Choice | The key in `step.data` whose value goes into the field, or `none`. |
| Expect | Noul | The probability that the `expect` text is visibly true on the page. |

Jev sees this state for each decision:

- **Page:** the URL, the title, and the visible text.
- **Elements:** the role, the accessible name, the nearby context, and the states `value`, `checked`, `selected`, `expanded`, `pressed`, and `haspopup`. Jev can see that a switch is already on, or that a button opens a closed menu. The value of a password field is never sent.
- **Recent actions:** the last 10 actions. Each action shows whether the page changed, and which lines of page text it removed and added. Jev uses this evidence to choose `DONE` after a save moves the page to a new view.

The rules in `src/jev/prompts.ts` tell Jev how to act on this state. For example, Jev does not click a switch that is already in the requested state. Jev opens a likely menu, such as an account menu with the user's initials, before it chooses `BLOCKED`.

`TYPE_TEXT` is offered only for editable roles. It is never offered for a checkbox, radio, or switch.

### Guards and results

Before each action, code checks that the page fingerprint did not change, and that the target is visible, enabled, and not covered. Code also checks that the page stays in `allowHosts`. Code acts only through the stored node from the snapshot and never builds a selector from model output.

A step ends with one of these results:

| Result | Cause |
| --- | --- |
| `pass` | Jev chose `DONE`, and the expect probability is at or above `expectPass` (0.7). A step with no `expect` passes on `DONE`. |
| `fail` | The expect probability is at or below `expectFail` (0.3). |
| `unclear` | The decision confidence is below `confidence` (0.5), or the expect probability is between the two thresholds. |
| `blocked` | Jev chose `BLOCKED`, the page left `allowHosts`, or a limit stopped the step: the action limit, the time limit, or 3 actions in a row (`stuckActions`) that did not change the page or that code refused. |

A typed value comes from `step.data` when Jev chooses a matching key. Otherwise a small text model writes it. The report records the source of each value. Password fields never go to a model.

Each run writes `report.json` and screenshots to a private temporary directory outside the checkout by default. The CLI prints the report path. Reports contain the exact decision requests and page-change evidence. To test a prompt change against a real decision, send a recorded request again:

```sh
pnpm tsx scripts/replay-turn.ts <report.json> <step> <turn> --times 3
```

### Scenarios, login, and config

To run as a logged-in user, save a session once, then point `qavo.config.ts` (or `--storage-state`) at it:

```sh
qavo login http://localhost:5173
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

### Create scenarios

Use `scenario new` to turn test instructions into one or more confirmed scenario files. The command accepts pasted stdin, `.txt` files, and local `.docx` files. It calls no model:

```sh
qavo scenario new
qavo scenario new --url localhost:5173 --from instructions.docx --out qa/scenarios
```

The command asks for the start URL first, unless you give `--url`. A URL without a scheme gets `http://`. When you paste instructions, finish with `.qavo-end` on its own line. The command also accepts `Ctrl-D` after an empty line.

Code uses only the structure of the input. It copies your text into the steps and does not rewrite it:

| Input | Result |
| --- | --- |
| `# Name` line, or a DOCX Heading or Title paragraph | Starts a new scenario with that name |
| List item (`1.`, `1)`, `-`, `*`, `Step 1:`), or a DOCX numbered paragraph | One step |
| `Expected: ...` after a step | The `expect` of that step |
| Table row, with `Action` and `Expected` columns when the table has a header row | One step, with its `expect` |
| Paragraph in a scenario with no list or table | One step |
| Paragraph in a scenario with a list or table | A note that the preview shows, not a step |

Write one change of state in each step, and add `Expected:` for the check. A step such as "turn the switch on and off" changes the same control two times, and the page cannot show which change is done. Write two steps instead.

The preview shows each scenario. Approve, edit, or cancel. Use edit to change the name, URL, step text, expected result, or data keys. The command writes files only after approval, and it never runs a scenario. The default output directory is the current directory. Data keys become `@env:NAME` references, and the command asks for each environment variable name.

### Environment data

Use an exact reference in `step.data`, such as `"password": "@env:QA_PASSWORD"`. Supply the variable through your environment or CI secret store. Missing variables and malformed references fail before the browser starts. Literal values still work. References do not expand inside larger strings or recursively.

All env-resolved values are sensitive, including values entered into non-password fields. Reports and action history use `***`. Model requests and reports also replace known secret text and its URL-encoded form. This replacement does not recognize arbitrary application transformations of a secret.

Runs with env references omit screenshots because the application can display secrets anywhere on the page. Runs without env references retain screenshots. Keep all reports private.

### Artifact output

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

## Develop qavo

```sh
git clone https://github.com/smaldd14/qavo.git
cd qavo
pnpm install
pnpm exec playwright-core install chromium
pnpm link --global     # puts this checkout's `qavo` on your PATH
pnpm fixtures          # in a second terminal: serves test/fixtures on http://127.0.0.1:4173
```

Before a commit, run `pnpm test`, `pnpm typecheck`, and `pnpm knip`. Tests run offline against `test/fixtures/*.html`. Read [CLAUDE.md](CLAUDE.md) for the rules, [CONTEXT.md](CONTEXT.md) for the terms, and [docs/plan.md](docs/plan.md) for the iterations.

A change to a `qavo browser` command, output field, or error code must also update [`skills/qavo-browser/`](skills/qavo-browser/). `test/docs.test.ts` checks that each command and error code is in the reference.

## Status

v0 is in progress. See [docs/plan.md](docs/plan.md) for the iterations and [CONTEXT.md](CONTEXT.md) for the terms.

## Inspiration

qavo is inspired by [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). That project showed that a browser agent can run on typed Jev choices: one operation head, one target head for each operation, and a small text model for field values. qavo ports these ideas to TypeScript and adds scenarios, `expect` checks, and QA reports. qavo does not copy its code.

## License

MIT
