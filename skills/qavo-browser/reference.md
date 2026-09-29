# qavo browser reference

`qavo browser` drives a real Chromium page for a coding agent, one command at a time. No model runs inside qavo. The agent reads the page, decides, and sends the next command.

`qavo browser --help` and `qavo browser <command> --help` print the same facts at the command line.

## How it works

`qavo browser start <url>` starts a **driver**: a background process that owns one browser page. Each later command connects to the driver through a Unix socket, sends one request, prints one JSON object, and exits. The page stays open between commands, so the app keeps its state.

```
agent ──> qavo browser click 7 ──(socket)──> driver ──> Chromium page
agent <── one JSON object on stdout <──────── driver
```

- The driver files are in `~/.qavo/drivers/<name>/`: `driver.sock`, `state.json`, `driver.log`, and `screenshots/`. Set `QAVO_HOME` to use a different root than `~/.qavo`.
- `--name <driver>` (or the `QAVO_DRIVER` environment variable) picks a driver. The default name is `default`. Use one name for each checkout or task, so that two agents do not share one page.
- The driver stops after 30 minutes with no command. `--idle-minutes` on `start` changes this.

## Output

Each command prints exactly one JSON object on stdout.

- Success: `{ "ok": true, ... }` and exit code `0`.
- Failure: `{ "ok": false, "error": { "code", "message", "hint", ... } }` and exit code `1`. The `hint` says what to run next.

`--help` prints plain text, not JSON.

## Commands

| Command | What it does |
| --- | --- |
| `start [url]` | Starts a driver and opens `url`. Fails with `already_running` if a driver with that name answers. |
| `stop` | Closes the browser and removes the driver files. It also cleans up a driver that crashed. |
| `status` | Shows the driver's URL, title, `allowHosts`, and process. |
| `doctor` | Checks Node, Chromium, and the driver. Each failed check has a `fix`. It works with no driver. |
| `open <url>` | Goes to a URL or a path, then waits until the page settles. A path resolves against the current page. |
| `snapshot` | Waits until the page settles, then returns the full page state. |
| `click <index>` | Clicks an element. |
| `type <index> <text>` | Replaces the text in an editable element. `type <index> ""` clears it. |
| `type <index> --env NAME` | Types the value of environment variable `NAME`. A password field accepts only this form. |
| `select <index> <value>` | Chooses an option in a native `<select>` by option `value`. |
| `press <key>` | Presses a key on the focused element, for example `Enter`, `Escape`, `Tab`, `ControlOrMeta+KeyK`. |
| `scroll <up\|down>` | Scrolls by most of one screen. |
| `wait-settle` | Waits until the page settles. Returns a short summary. |
| `screenshot [path]` | Saves a PNG. `--full-page` captures the full page. Without `path`, saves in the driver's `screenshots/` directory. |
| `network [id]` | Lists the page's requests with status and time, or shows one request with its bodies. See [Network](#network). |
| `console` | Lists console messages and uncaught page errors. See [Console](#console). |
| `eval <expression>` | Reads page state with a JavaScript expression and returns JSON. It is not an action. See [Eval](#eval). |

### `start` options

| Option | Effect |
| --- | --- |
| `--headed` | Shows the browser window. Use it when a human wants to watch. |
| `--allow-host <host>` | Adds a host (with port) that the page can visit. Repeat it for more hosts. |
| `--storage-state <file>` | Loads a login session that `qavo login` saved. |
| `--config <file>` | Uses this `qavo.config.ts`. Without it, `start` looks for `qavo.config.ts` in the current directory and its parents. |
| `--idle-minutes <n>` | Stops the driver after `n` minutes with no command. The default is 30. |

`start` gets `url`, `allowHosts`, and `storageState` from the config when you do not give them. With a config `url`, `start /settings` opens a path in that app. Without a config `allowHosts`, the only allowed host is the host of `url`.

### Action options

`click`, `type`, and `select` take these options:

| Option | Effect |
| --- | --- |
| `--dry-run` | Runs the guards and names the target. Sends no input to the page. |
| `--fp <fingerprint>` | Checks against this fingerprint instead of the fingerprint from the last snapshot or action. |

## The snapshot

```json
{
  "ok": true,
  "url": "http://127.0.0.1:4173/spa.html",
  "title": "Queue",
  "text": "DS\nOpening balances\n2 left\n112 Automotive Blvd\nOwed at takeover\nSave and next",
  "elements": [
    { "index": 1, "role": "button", "name": "DS", "expanded": false, "haspopup": "menu", "operations": ["CLICK"] },
    { "index": 2, "role": "textbox", "name": "Owed at takeover", "value": "0.00", "operations": ["TYPE_TEXT"] },
    { "index": 3, "role": "button", "name": "Save and next", "operations": ["CLICK"] }
  ],
  "omitted": 0,
  "scroll": { "y": 0, "max": 0 },
  "fingerprint": "e396c9bf"
}
```

| Field | Meaning |
| --- | --- |
| `text` | The visible text of the page, one line for each text node, to 6000 characters. |
| `elements` | The controls that you can act on: visible, enabled, and not covered. At most 250. |
| `elements[].index` | The number to pass to `click`, `type`, or `select`. |
| `elements[].role`, `name` | The accessible role and name, for example `button` "Save". |
| `elements[].value` | The current value of a field. A password field never has a `value`. |
| `elements[].sensitive` | `true` for a password field. Type into it only with `--env`. |
| `elements[].checked`, `selected`, `expanded`, `pressed`, `haspopup` | The control's state. Read `checked` before you click a switch or a checkbox. |
| `elements[].context` | Text from the nearest row, list item, card, fieldset, or dialog. Use it to tell apart two buttons with the same name, for example two "Edit" buttons in a table. |
| `elements[].operations` | The commands that the element accepts: `CLICK`, `TYPE_TEXT`, or `SELECT`. |
| `elements[].options` | For `SELECT`: each option's `value` and `label`. Pass the `value`. |
| `omitted` | The number of controls after the first 250. If it is not 0, the page has more controls than the snapshot shows. |
| `scroll` | The scroll position `y` and the largest position `max`. |
| `fingerprint` | A hash of the URL, the form values, and the controls. Actions check it. |

Rules for elements:

- When a dialog is open, the snapshot lists only the controls inside the top dialog.
- An element that another element covers (a toast, a sticky header, an overlay) is not in `elements`.
- Elements below the fold are in the snapshot. You do not need to scroll to act on them.
- An index stays the same for the same element until the page reloads. A new element gets a new index. After a navigation, take a new snapshot before you use an index.

## Action results

An action waits until the page settles and returns a short summary, not the full snapshot:

```json
{
  "ok": true,
  "target": { "index": 3, "role": "button", "name": "Save and next" },
  "url": "http://127.0.0.1:4173/spa.html",
  "title": "Queue",
  "fingerprint": "669364f5",
  "elements": 3,
  "pageChanged": true,
  "changes": { "removed": ["2 left", "112 Automotive Blvd"], "added": ["1 left", "21 Aberdeen Ave"] },
  "network": { "requests": 1, "failed": [] },
  "console": { "errors": 0, "warnings": 0, "messages": [] }
}
```

- `pageChanged` is `true` when the fingerprint or the text changed.
- `changes` lists up to 8 text lines that the action removed and added. It is absent when no text changed. This is the fastest way to see what an action did.
- `elements` is a count. To see new elements, run `snapshot`.
- `fingerprint` becomes the fingerprint for the next action. You can do several actions in a row without a snapshot, as long as you act on elements that you already know.
- `network` counts the app requests that the action caused (document, fetch, XHR, WebSocket, EventSource) and lists up to 5 that failed. A request failed when it has a `failure` or a status of 400 or more.
- `console` counts the errors and warnings that the action caused and shows up to 3 errors. An uncaught exception has the level `pageerror`.
- `type` adds `typed: { characters, env? }`. It never shows the typed text.

`open` returns the same `network` and `console` summary. `click`, `type`, `select`, `press`, `scroll`, and `open` each start a new "last action" for `network --last-action` and `console --last-action`.

## Guards

Before `click`, `type`, or `select`, the driver checks these guards. If a guard fails, the driver sends no input and returns `error.code: "refused"` with a `reason`.

| `reason` | Cause | What to do |
| --- | --- | --- |
| `stale` | The page changed after your last snapshot or action. | Run `snapshot`, then use the new indices. |
| `missing` | The element is no longer on the page. | Run `snapshot`. |
| `hidden` | The element is hidden, for example in a closed menu or tab. | Open the menu or tab, then run `snapshot`. |
| `disabled` | The element is disabled. | Fill the required fields first, or run `wait-settle`. |
| `covered` | Another element covers the target's center. | Close the dialog or toast, or run `wait-settle`, then `snapshot`. |
| `not_editable` | `type` on an element that is not a textbox, searchbox, spinbutton, or editable combobox. | Use `click` for a checkbox, radio, or switch. |
| `option` | `select` with a value that is not an enabled option. | Use a `value` from `options` in the snapshot. |
| `host` | A link goes to a host that is not in `allowHosts`. | Restart the driver with `--allow-host <host>` if the host is part of the app. |

The driver also blocks each main-frame navigation to a host outside `allowHosts`, for example a form post or a script redirect.

## Error codes

| `code` | Cause | What to do |
| --- | --- | --- |
| `refused` | A guard stopped the action. See `reason` above. | Follow the `hint`. |
| `no_snapshot` | An action ran before any snapshot. | Run `snapshot`. |
| `not_running` | No driver answers for this name. | Run `start <url>`, with the same `--name`. |
| `already_running` | `start` found a driver with this name. | Use it, run `stop` first, or use another `--name`. |
| `start_failed` | The driver could not open the URL, or it did not start. | Check that the app runs at the URL. Read `driver.log`, then run `doctor`. |
| `navigation_failed` | `open` could not load the URL. | Check that the app still runs. |
| `host_not_allowed` | `open` to a host outside `allowHosts`. | Restart with `--allow-host <host>`. |
| `bad_url` | `open` got a value that is not a URL or a path. | Pass an absolute URL or a path such as `/settings`. |
| `secret_literal` | `type` with literal text into a password field. | Put the value in an environment variable, then use `--env NAME`. |
| `missing_env` | `--env NAME`, and `NAME` is not set. | Set it in the shell or in `.env` in the current directory. |
| `no_storage_state` | The `--storage-state` file does not exist. | Ask a human to run `qavo login <url>`. |
| `bad_key` | `press` got an unknown key name. | Use a Playwright key name, for example `Enter` or `ArrowDown`. |
| `bad_path` | `screenshot` got a path that the driver cannot use. | Pass an absolute path, or no path. |
| `bad_name` | `--name` has characters other than letters, digits, `-`, or `_`, or is longer than 40. | Use a short plain name. |
| `path_too_long` | The socket path is longer than the Unix limit (about 103 bytes). | Set `QAVO_HOME` to a short directory, for example `/tmp/qavo`. |
| `timeout` | The driver did not answer in time. | Run `doctor`. If it stays stuck, run `stop`, then `start`. |
| `usage` | Wrong arguments. | Run `qavo browser <command> --help`. |
| `unknown_command` | The command does not exist. | Run `qavo browser --help`. |
| `bad_request` | The driver got a request that it cannot parse. | Run `qavo browser --help`. Report it as a bug if it continues. |
| `not_found` | `network <id>` with an id that the driver does not have. | Run `network` to list the ids. The driver keeps the last 500. |
| `eval_failed` | The expression threw an error or is not one expression. | Read the message. Wrap statements in `(() => { ...; return value; })()`. |
| `eval_timeout` | The expression did not finish in 10 seconds. | Do not wait on a promise that never resolves. Use `wait-settle` to wait for the page. |
| `node_version` | Node is older than 24. | Install Node 24 or later. |
| `driver_error`, `error` | An unexpected failure. | Run `doctor`, and read `driver.log`. |

## Network

The driver records each request that the page makes, from the start of the driver. It keeps the last 500.

```sh
qavo browser network --last-action      # the requests that the last action made
qavo browser network --failed           # all failed requests
qavo browser network --filter /api/orders
qavo browser network 42                 # one request with its bodies
```

```json
{ "ok": true, "requests": [
  { "id": 42, "method": "POST", "url": "http://localhost:5173/api/orders", "type": "fetch", "status": 500, "durationMs": 55 }
], "cursor": 44 }
```

| Field | Meaning |
| --- | --- |
| `id` | The number to pass to `network <id>`. Requests and console messages share one sequence. |
| `type` | The resource type: `document`, `fetch`, `xhr`, `websocket`, `eventsource`, `script`, `stylesheet`, `image`, `font`, and others. |
| `status` | The HTTP status. |
| `failure` | Why the request did not complete, for example `net::ERR_CONNECTION_REFUSED` or `net::ERR_ABORTED`. |
| `durationMs` | The time from the request to its end. A request with `pending: true` has not ended. |
| `cursor` | The last id so far. Pass it as `--since <cursor>` to list only newer entries. |
| `omitted` | The count of matches before the last `--limit` entries. |

Options: `--failed` lists only failed requests. `--filter <text>` keeps URLs that contain the text. `--all` adds scripts, styles, images, and fonts, which are left out unless they fail. `--last-action`, `--since <cursor>`, and `--limit <n>` (default 50) select the range.

`network <id>` adds `requestContentType`, `requestBody`, `responseContentType`, and `responseBody` for text types (JSON, text, XML, form data). Each body is cut at 4000 characters, with `requestBodyTruncated` or `responseBodyTruncated`. A response body can be lost after the page navigates. Headers are never shown, because they can hold tokens and cookies.

## Console

The driver records console messages and uncaught page errors. It keeps the last 500.

```sh
qavo browser console --level error
qavo browser console --last-action
```

```json
{ "ok": true, "messages": [
  { "id": 43, "level": "error", "text": "Save failed: Database is down", "location": "http://localhost:5173/src/orders.tsx:27" },
  { "id": 44, "level": "pageerror", "text": "TypeError: Cannot read properties of undefined (reading 'total')", "location": "at OrderTotal (http://localhost:5173/src/total.tsx:12:9)" }
], "cursor": 44 }
```

The levels are `log`, `info`, `debug`, `warning`, `error`, and `pageerror`. `--level error` lists `error` and `pageerror`. `--level warning` adds `warning`. The default is `all`. Each text is cut at 500 characters. The browser's own "Failed to load resource" errors are left out, because `network` shows those requests.

## Eval

`eval` runs one JavaScript expression in the page and returns its value as JSON. Use it to read what a snapshot does not show:

```sh
qavo browser eval "localStorage.getItem('theme')"
qavo browser eval "getComputedStyle(document.querySelector('main')).display"
qavo browser eval "document.querySelectorAll('[data-testid=order-row]').length"
qavo browser eval --file /tmp/read-cart.js
```

```json
{ "ok": true, "value": "dark", "pageChanged": false }
```

- A promise is awaited for 10 seconds at most.
- An element becomes a short tag, such as `"<h1>"` or `"<input#email>"`. A cycle becomes `"[circular]"`. A `Map` becomes an object, and a `Set` becomes an array.
- A value over 20000 characters comes back as `valueText` with `truncated: true`.
- For statements, wrap them in a function: `(() => { const rows = document.querySelectorAll('tr'); return rows.length; })()`.

`eval` is for reading, not for acting:

- It passes no guards, and it does not update the fingerprint that actions check.
- If the expression changed the page, the result has `pageChanged: true` and a `warning`. The next action is then refused as `stale` until you take a snapshot.
- Do not use `eval` to do the step that you verify. A check that submits a form through `eval` proves nothing about the UI that a user sees.

## Credentials

- A password field accepts text only from `--env NAME`. The value comes from the shell environment or from `.env` in the current directory. The value never passes through the agent's context.
- No output shows a typed value, a password value, or an `--env` value. Each value typed with `--env` is replaced by `***` in `network`, `console`, and `eval` output, also in its URL-encoded form.
- `network` never shows headers. Request and response bodies can still hold customer data or tokens that the app puts in a body. Treat the output as private.
- `qavo login <url>` opens a browser for a human to log in, then saves the session. It needs a human at the terminal, so an agent cannot run it. The session file has cookies and tokens. Do not read it, print it, or commit it.

## Limits

These are not supported now:

- File uploads, drag and drop, and hover.
- Content inside iframes.
- A second tab or popup window. A link that opens a new tab does not move the driver.
- Browser dialogs (`alert`, `confirm`). Playwright dismisses them.
- Clicking at a screen position (`click-xy`), and acting through a CSS selector. This is on purpose: each action goes through a snapshot index and the guards. `eval` can read the page, but it is not an action.
- Performance traces and metrics.
