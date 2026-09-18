# qavo terms

**Scenario.** A JSON file with a name, a start URL, and an ordered list of steps. A *goal* is a scenario with one step. A *step doc* is a scenario with many steps.

**Step.** One unit of work in a scenario. It has an `intent`, optional `data`, an optional `expect`, and an `actionLimit`.

**Intent.** The plain-language description of what the step must do, for example "Filter the table to open work orders". Jev reads the intent on each decision.

**Expect.** A plain-language statement that must be true after the step, for example "Only open work orders are listed". After `DONE`, one Jev yes/no question checks it against the page.

**Snapshot.** The result of one in-page read: the page URL, title, visible text (capped), the list of elements, and the fingerprint.

**Element.** A visible, enabled control in a snapshot. It has an index, a role, an accessible name, a value, state (`checked`, `selected`, `expanded`), and the operations it allows. The page keeps the live DOM node for each index, so code never builds a selector.

**Fingerprint.** A string made from the URL, the form values, and the element list. Code compares it before an action. A different fingerprint means the page changed, and the decision is stale.

**Operation.** The kind of action for one decision: `CLICK`, `TYPE_TEXT`, `SELECT`, `WAIT`, `SCROLL_DOWN`, `SCROLL_UP`, `DONE`, or `BLOCKED`.

**Target head.** One Jev choice question for each operation that has candidates (`CLICK_target`, `TYPE_TEXT_target`, `SELECT_target`). All heads run in the same request. Code uses only the head for the chosen operation.

**Guard.** A check just before an action: the fingerprint still matches, the element is connected, visible, enabled, and not covered at its center point, and the URL host is in `allowHosts`. A failed guard refuses the action. It does not retry the action.

**Value source.** Where a typed value came from. `data`: Jev chose a key from `step.data`. `model`: the text model wrote the value. Each typed value in the report has its source.

**Result states.**
- `pass`: every step reached `DONE`, and each `expect` check said yes.
- `fail`: a step reached `DONE`, but its `expect` check said no.
- `blocked`: Jev chose `BLOCKED`, a guard refused too many times, the page stopped changing, or a limit was reached.
- `unclear`: a Jev confidence was below the threshold, or the `expect` probability was between the pass and fail thresholds.

**Run.** One execution of a scenario. It writes `.qavo/runs/<id>/report.json` and screenshots.

**allowHosts.** The hosts that the browser can visit. A navigation to another host stops the step as `blocked`.
