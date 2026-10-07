# PRODUCT

How the VulnPen web app is laid out and what each screen owns. `GLOSSARY.md`
covers the domain and backend seams; this file covers the product surface so a
change lands in the right place instead of growing a second one beside it.

## Shape of the product

A **workspace** holds one engagement. An engagement is a **session** with a
declared target and scope, a WSTG **test plan**, the **scans** that execute
cases from that plan, the **findings** those scans produce, and a **report**
built from all of it. The agent is a participant in that workflow, not the
workflow itself: the conversational surface is one screen among several, and
the product is fully usable without ever opening it.

## Routes

| Route | Screen | Owns |
|---|---|---|
| `/dashboard` | Workspace list | Creating, opening and deleting workspaces |
| `/workspace/[id]` | Workspace detail | The engagement's sessions |
| `/session/[id]` | **Engagement overview** | The state of the work: coverage, findings, the scan of the moment, and the actions that follow from each |
| `/session/[id]/chat` | Agent chat | Talking to the agent, watching tool calls stream, answering consent prompts |
| `/session/[id]/test-plan` | Test plan | Choosing the WSTG cases, per-case status and notes, launching scans |
| `/session/[id]/test-plan/[testId]` | Case detail | One case: its method, its evidence, its own scan history |
| `/session/[id]/scans` | Scans | Launching a scan, the scan history, stopping and deleting |
| `/session/[id]/scans/[runId]` | Scan detail | One scan: progress, per-case results, its findings, the agent log |
| `/session/[id]/vulnerabilities` | Findings | Reading and triaging what the engagement found |
| `/session/[id]/report` | Report | The deliverable: editing it in LibreOffice, exporting it |
| `/session/[id]/burp` | Burp proxy | The proxy history, repeat/replay handoff |
| `/session/[id]/gui` | Desktop | The VNC desktop, and how to configure it |

The session root is the **overview**, never a blank composer: a landing screen
that answers "where does this engagement stand?" is the difference between a
tool and a demo. Every route above is reachable from the engagement rail.

**The scans page is the list.** A scan that is still moving is a card at the top
of that list — progress bar, Stop, Open — and a settled scan is one row of
columns. The headline tiles and the activity charts this page used to carry were
removed: every number they printed was already on the row it described, twice.
A page whose job is "launch a scan, watch one, read the history" earns its
clarity by having nothing else on it.

Two rules keep the rows honest:

- **A failure reason is counted once, not printed per row.** Twelve runs that
  died of the same rate limit used to print that sentence twelve times and bury
  everything else; identical reasons are now counted above the list and the row
  says only that the run stopped.
- **A result takes the shape its data can carry.** One case is a word
  (`passed`, `skipped`), because a proportion bar over a single value is a
  full-width rectangle that says nothing a word does not — and it lies about
  size: "1 passed" and "10 passed" drew the same bar. From two cases up the
  split is real, so the bar and its counts come back.

Settings is an overlay (`SettingsOverlay`), not a route. Session-scoped tabs
(Connection, VPN) only appear inside a session. `HeaderLinks` opens it by
dispatching a `window` CustomEvent named `open-settings` with
`detail: { tab: "<tab key>" }` — a bare string silently opens the wrong tab.

## The page pattern

Every screen renders inside the shared frame:

- **`PageShell`** owns the scrollbar, the reading measure and the responsive
  padding for session screens (everything under `/session/<id>`). A page never
  declares its own shell, and never takes another page's — that is how the case
  page once inherited a flex column with `overflow: hidden` and lost the bottom
  of its report.
- `DashboardLayout` provides the equivalent frame for account-level pages
  (`/dashboard`, `/workspace/<id>`) through `AppShell.module.scss`. There are
  exactly two frames, one per shell; nothing else declares page padding.
- **`PageHeader`** owns the back affordance, the action cluster, the title block
  and the metadata chips, so the title sits at the same height everywhere and
  the primary action never moves when a description wraps. The actions share the
  heading's first line: a bar of right-aligned buttons above an empty left half
  is a band of dead pixels at the top of every page, which is where the eye
  lands first. Pages whose body *is* an embedded tool (the report editor, the
  desktop) pass `compact`: the same header on one line, because every header
  pixel comes out of the tool.
- **`PageState`** owns *loading*, *empty* and *error*. A surface that can fail
  must offer a retry; a surface that can be empty must say what to do next.

These live in `components/common/ui` with `styles/components/Page.module.scss`.
The decorative kit in the same folder (`EmptyState`, `StatTile`, `StatStrip`,
`ProgressRing`, `SpotlightCard`, `AnimatedContent`, `CountUp`, `ShinyText`,
`MoonBackdrop`) exists to keep pages from hand-rolling a fourth version of the
same tile. A row of headline numbers is a `StatStrip` — one frame, hairline
dividers — not four separate boxes with a gap between them.

### The graphics kit

`components/common/ui` also owns every chart the product draws. The chart kit
lives in `graphics.module.scss`; `SeverityBar`, `CaseMatrix` and `StatStrip`
predate it and keep their rules in `ui.module.scss`. It is deliberately **not** a
charting library: each component is inline SVG or CSS grid, so a graph inherits
the palette, the type scale and the global `prefers-reduced-motion` rule, ships
no extra bytes, and survives inside a card that is 260px wide or 1200px wide
without a resize observer.

- `Sparkline` — a trend from a numeric series. Stretched with
  `preserveAspectRatio="none"` and drawn with `vector-effect="non-scaling-stroke"`,
  so the line keeps its weight at any width.
- `ColumnChart` — vertical bars for a small set of categories; each column
  prints its own value in the band above it, so no legend or gridline is needed.
- `BarList` — ranked horizontal bars: labels keep their full name, tracks stay
  comparable because every row scales against the same maximum.
- `DonutChart` — a part-of-whole split with the total in the hole, which is the
  one thing a pie does better than a bar.
- `RadarChart` — coverage across ordered categories (the ten WSTG chapters). The
  *outline* answers "where are we thin?", which ten separate rows ask the reader
  to reconstruct.
- `GaugeArc` — a single score against its ceiling (a CVSS base score, a
  confidence, a completion ratio).
- `TimelineChart` — spans on one shared axis: when the recent runs happened, how
  long each took, and where the gaps are.
- `SeverityBar` — the findings distribution as one stacked bar plus a one-line
  legend, replacing five bordered pills.
- `CaseMatrix` — one square per planned case, in plan order, grouped by
  category: the ratio *and* the outcome, which a bar alone cannot show. The row
  label is the category code.

A chart is only added where the data can carry it. Two shapes were built and
then removed because nothing honest fed them: a heatmap (every dated series in
the product already has a sparkline or a timeline, so it would have restated
one) and a trend pill (no endpoint returns a previous period to compare
against). If a chart has no call site, it is not part of the kit.

Every `tone` a graphic accepts is a palette key (`accent`, `success`, `warning`,
`danger`, `info`, `mute`, or a severity key `critical|high|medium|low`), resolved
by the `tone_*` classes in `graphics.module.scss` and, for `StatTile`, by the
`statTile*` classes in `ui.module.scss`. A chart never carries its own hex value:
the palette is the one place a colour is decided, so a table, a chip and a bar
for the same severity can never disagree.

Charts that need arithmetic keep it in `utils/*.mjs` as a pure, tested function
(`scanTimeline`, `scanActivity`, `findingsBySeverity` in `utils/scans.mjs` and
`utils/findings.mjs`) — never inline in a memo in a page, where a duration rule
would have to be written twice and drift.

Two surfaces are deliberately full-bleed: the Burp history and the desktop own
their own scroll region (a proxy table, a VNC iframe) and opt out of the frame's
scrolling while keeping its padding and header.

**A full-bleed page has to keep the flex chain unbroken.** `PageShell` wraps its
children in `.pageInner`, which is a plain block; a `.frame { flex: 1 1 auto }`
inside it therefore has nothing to grow into and only ever reaches its own
`min-height` — that is the "the Word editor is only half the screen" bug. A page
that wants the leftover height passes `innerClassName` and makes that wrapper
`display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0` (see
`Report.module.scss`, `Desktop.module.scss`). The `min-height` on such a frame is
a floor for short windows, not a target: because the shell keeps
`overflow-y: auto`, a window shorter than the floor scrolls instead of clipping
the tool's toolbar.

### Tables

Four surfaces render tabular data — the test plan, the scan list, the findings
table and the Burp history (antd). They all dress themselves from one skin in
`_variables.scss` (`@include tableHead`, `tableCell`, `tableRowHover`), so a
header that recedes and a hairline row rhythm are one decision instead of four.
Density differs on purpose (the proxy log is read at speed, findings one row at
a time); the palette does not.

A clickable row is still a row: the *name* in it is a real link and the row's
own click handler is a mouse shortcut that stands down when the click landed on
a link or a button (`event.target.closest("a, button")`). That is what gives the
row one Tab stop, a focus ring, a new-tab affordance, and no double history
entry from following the link twice.

### Every query declares its failure branch

`useQuery` hands back `data: undefined` for three different facts — "still
loading", "the API failed", and "the API answered with nothing". A screen that
branches only on `data` shows the other two as if they were the third. Every
`useQuery` destructure in this repo is expected to mention `isError`/`error`,
even when the answer is "fall back quietly".

Surfaces that deliberately fall back, because a failure there cannot lead the
operator into a wrong action:

| Surface | Falls back to | Why that is safe |
|---|---|---|
| Sidebar badges | no badge at all | an absent badge is not a zero |
| `ExecutionModeSelector` | the `auto` mode | the menu is static and picking a mode is idempotent |
| Login registration link | the link is shown | the register page itself says when registration is closed |
| Session header / SSH back link | no breadcrumb | cosmetic; the route still works |
| Findings and scan-detail plan labels | "Test plan" | labels only; the findings came from their own query |
| Model-ID suggestions | the built-in `FALLBACK_MODELS` list | the field stays usable, and the provider validates the ID anyway |

Everything else names the failure and offers a retry: the Burp connection, CA
and intercept status; the VPN tunnel state (`UNKNOWN`, never `IDLE`); the
desktop configuration; the model list; the report; the plan; the workspace list.

## Rules the UI is expected to keep

1. **A failed read is not an empty state.** "Nothing here yet" and "we could not
   load it" have different actions: one invites you to create something, the
   other offers a retry. Rendering the first for the second is how a transient
   error becomes a destructive click (the plan screen once offered to rebuild
   the whole plan from the 97-case catalogue on a failed refresh).
2. **Never let a form load from a failed request.** Saving an unloaded form
   writes defaults over real configuration. Settings pages branch on `isError`
   before they render a form.
3. **Live numbers belong to the thing that is live.** A scan's progress counts
   the cases *that scan* settled (`updatedAt >= startedAt`); the plan's statuses
   are the engagement's long-term truth. A settled scan reads its own snapshot
   so history never rewrites itself.
4. **Destructive actions confirm and name the cost.** Stopping a running scan
   is the most destructive action in the product — it cannot be resumed — so it
   asks first and says how many cases have no result yet.
5. **Consent must be unmissable.** Arriving consent scrolls the transcript to
   the banner, the banner is a live region, buttons lock on the first click, and
   a delivery failure is reported instead of swallowed.
6. **Answers arrive before they are lost.** A user turn is echoed when the
   request is accepted, and a failed transcript load says so rather than
   presenting an empty session.
7. **One visual vocabulary.** Colours come from the `--moon-*` tokens, tone and
   severity from `--moon-success/warning/danger/info` and the severity ramp
   `--moon-critical/high/medium/low/info-sev`. A page does not define its own
   palette, and severity is not "danger": the same finding must not be one red on
   the overview and another red in the findings table.
8. **A card or row that navigates contains a real link, and nothing else
   interactive.** The whole workspace card is an `<a>` so it middle-clicks,
   right-clicks and costs one Tab stop — which means the delete button is a
   *sibling* of the anchor, not a child of it. Table rows keep their click as a
   shortcut while the name in them carries the link. A `<div role="button">`
   wrapped around a real `<button>`, or a focusable `<tr>` with an `onKeyDown`,
   is invalid HTML, loses open-in-new-tab, and swallows the inner click.
9. **No action, no alarm.** A warning the reader cannot act on is noise, so the
   model banner separates three facts that look alike: *no model configured*
   (owner, with a button into Settings › Models), *you are not the owner*
   (explanation, no button), and *the check itself failed* (retry). See rule 1.
10. **A selector written twice is a selector that fights itself.** When a nested
    rule (`.dashboardContainer .workspaceGrid`) and a top-level rule
    (`.workspaceGrid`) both exist, the nested one wins on specificity no matter
    where it sits in the file — so the "redesign at the bottom" silently never
    applies. Keep one definition per class in a module; a nested rule is only for
    a *state* (`.typeSelected .typeIcon`) or a *context* (`.burpContainerPage
    .header`) that the top-level rule cannot express.
11. **A screen explains itself with a shape before it explains itself with a
    sentence.** Numbers that belong together go into one graphic — a
    `SeverityBar`, a `CaseMatrix`, a proportion bar in a table cell — and the
    sentence that used to introduce them is deleted. The page description is one
    clause; an empty or error state is a title plus one sentence; a rule that
    needs a paragraph belongs in this file, not on the screen. The operator is
    reading a scanner, not documentation.

## Deliberate decisions

- **Scan policy defaults to `unattended`.** Pressing Scan means the scan
  finishes; `supervised` is available where a human wants the gate.
- **The consent banner stays in Thai** while the rest of the UI is English: it
  is the human-approval gate for a Thai-speaking operator, and the generated
  client reports are Thai too. Changing it is a product decision, not a
  translation fix.
- **The report is a working document.** Once it is saved in Word, later scans
  and findings are deliberately not merged; the page says so and offers an
  explicit regeneration that discards the hand edits.
- **The model banner never blocks and never persists.** VulnPen is usable before
  a model is configured, so the banner is a strip under the header, not a gate;
  dismissing it lasts until a reload (`ModelSetupGate` keeps that in component
  state rather than storage, which would cost an effect and a second render pass
  on every page).
