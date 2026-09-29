# {{App name}} dev environment

Each command here was run and worked on {{date}}. Keep them exact. An agent copies them.

## Prerequisites

- {{Runtime and version, for example Node 22, Python 3.12, Docker}}
- qavo: `npm install -g github:smaldd14/qavo`, then `qavo browser doctor`.
- Environment variables: copy `{{.env.example}}` to `{{.env}}`. The variables that verification needs:

| Variable | What it is | Where a person gets it |
| --- | --- | --- |
| `{{TEST_USER_EMAIL}}` | {{The test user's email}} | {{Team password manager entry, or the seed script}} |
| `{{TEST_USER_PASSWORD}}` | {{The test user's password}} | {{Same}} |

## Install

```sh
{{install command}}
```

## Seed data

```sh
{{seed or reset command}}
```

{{What the seed creates, for example: two organizations, an admin and a member in each, 20 orders. Name the records that feature files use.}}

## Start

```sh
{{start command, for example `pnpm dev`}}
```

- The app is ready when {{the log line, or `curl -sf http://localhost:5173/health`}}. It takes about {{N}} seconds.
- URLs: app {{http://localhost:5173}}, API {{http://localhost:8787}}.
- `allowHosts` for qavo: {{localhost:5173, localhost:8787}}. Put them in `qavo.config.ts`, or pass `--allow-host` to `qavo browser start`.

## Log in

{{Choose one and delete the other.}}

**Saved session.** A person runs this once on each machine. An agent cannot, because it needs a human:

```sh
qavo login {{http://localhost:5173/login}} --out ~/.qavo/sessions/{{app}}-{{role}}.json
```

Then start qavo with `--storage-state ~/.qavo/sessions/{{app}}-{{role}}.json`.

**Login form.** The agent logs in through the UI:

```sh
qavo browser start {{http://localhost:5173/login}} --name {{app}}
qavo browser snapshot --name {{app}}
qavo browser type <email index> "$TEST_USER_EMAIL" --name {{app}}
qavo browser type <password index> --env TEST_USER_PASSWORD --name {{app}}
qavo browser click <sign-in index> --name {{app}}
```

## Test users and roles

| Role | Session file or variables | Can see |
| --- | --- | --- |
| {{admin}} | {{~/.qavo/sessions/app-admin.json}} | {{Everything, including Billing}} |
| {{member}} | {{~/.qavo/sessions/app-member.json}} | {{No Billing tab}} |

## Feature flags and external services

- {{Flag name}}: {{how to turn it on for a session, for example an env variable, an admin page, or a query parameter}}.
- {{External service, for example Stripe or email}}: {{the test mode or the stub, and how to see what it received}}.

## Check that it works

```sh
qavo browser start {{url}} --name {{app}} {{--storage-state ...}}
qavo browser snapshot --name {{app}}    # expect: {{a text line that shows you are logged in}}
qavo browser stop --name {{app}}
```

## Stop and reset

```sh
{{stop command}}
{{reset command}}
```
