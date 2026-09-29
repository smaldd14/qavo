# {{App name}} feature map

A map of what a user can do in {{App name}}. Each feature has a file with how to reach it, how to drive it with `qavo browser`, what to check, and the gotchas. An agent reads this file to find the features that a change touches.

| Feature | What a user does | Code | Verified |
| --- | --- | --- | --- |
| [{{Feature name}}]({{feature-file}}.md) | {{One line, from the user's view}} | `{{src/features/orders/**}}` | {{2026-01-31 @ abc1234, or "not yet"}} |

## Journeys across features

{{Flows that cross several features, for example "Create an order, pay it, then see it in Reports". Link each feature. Delete this section if there are none.}}

## Not in the map

{{Areas that no feature file covers yet, and why, for example "Admin console: needs a support login".}}
