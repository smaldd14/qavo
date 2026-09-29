---
feature: {{Feature name}}
code:
  - {{src/features/orders/**}}
  - {{api/routes/orders.ts}}
verified: {{2026-01-31 @ abc1234, or "not yet"}}
sources:
  - {{https://example.atlassian.net/wiki/spaces/QA/pages/123 (version 14)}}
---

# {{Feature name}}

{{One or two sentences: what the feature is for, from the user's view.}}

## Sub-features

- {{sub-feature}}: {{one line}}

## How to get to it (user view)

{{The clicks and keys that a user uses, for example: "Open Orders from the left nav. Click New order."}}

- Route: `{{/orders/new}}`
- Role: {{the role that can use it, and a role that cannot}}
- Data: {{the seeded records that it needs, for example "Customer Acme Corp"}}

## Drive it with qavo browser

```sh
qavo browser open {{/orders/new}} --name {{app}}
qavo browser snapshot --name {{app}}
# Find the elements by role and name, not by index:
#   textbox "Customer", combobox "Product", button "Create order"
qavo browser type <Customer> "Acme Corp" --name {{app}}
qavo browser click <Create order> --name {{app}}
qavo browser network --last-action --name {{app}}
```

## What to check

| Check | Evidence |
| --- | --- |
| {{The order shows in the list}} | `changes.added` has {{"Acme Corp"}} |
| {{The API saved it}} | {{`POST /api/orders` returns 201, and the response has `status: "draft"`}} |
| {{No errors}} | `network.failed` is empty and `console.errors` is 0 |

## Regression checks

{{Behavior near this feature that a change often breaks, for example "The total updates when the quantity changes".}}

## Gotchas

- {{Something that is not obvious, for example: "The Save button is disabled until the address check finishes. Run `wait-settle` after you type the ZIP code."}}
