# GLOSSARY

Domain and seam vocabulary for this codebase. The architecture vocabulary
(module, interface, depth, seam, adapter, leverage, locality) follows
`.zcode/skills/codebase-design/SKILL.md`. This file names the concepts that
recurred often enough to earn a seam — use these names when touching the areas
below, and add a term here when a refactor gives a concept a module of its own.

## VPN

**VPN profile store** — the local `.ovpn`/`.conf` bundles under
`kali-data/vpn-profiles`, owned by
`services/vpn-profiles.service.ts`: `sanitizeProfileName`,
`listLocalProfiles`, `findProfile`, `saveProfile` (replaces an existing
same-name profile plus its asset dir, rolls back on duplicate asset
names), `deleteProfile`, and `requiresInteractiveAuth`. The HTTP
handlers in `vpn.controller.ts` map requests to these verbs; they never
touch the directory layout or the sanitize rule themselves.

## Shell

**Shell I/O** — the mechanics of a shell's output channel, owned by
`services/shell-io.ts`: the bounded `RingBuffer` tail with its
async-offset resume protocol, `escapeForLoginShell`, `stripAnsi`, and
the local-process `RuntimeChannel` adapter. `ShellManager` composes
them; it owns session lifecycle (connect, reconnect, shell registry),
never the buffer/escape rules.

## OAuth

**Anthropic OAuth** — the PKCE connect flow, owned by
`services/anthropic-oauth.service.ts`: `beginAnthropicOAuth` (mint state
+ consent URL), `completeAnthropicOAuth` (verify state, exchange the
code, persist tokens via `applyEnvUpdates`), and
`disconnectAnthropicOAuth`. Controllers map HTTP to these verbs only.

## Engagement

**Engagement** — one session's offensive-testing effort against a declared
**Target** (the only field that arms the deterministic scope gate) plus free-text
**Scope** (parsed into the host allowlist).

**Engagement state** — the structured, in-memory record of what the agent has
learned (hosts, services, credentials, vulnerabilities, shells, files,
approaches, next steps). Lives in `backend/src/services/engagement-state.ts`,
which owns the whole lifetime: `engagementStateFromSession` restores it from
the session document (declared boundary, vulnerabilities, and the persisted
`engagementState` snapshot) and wires the Mongo persister; tools mutate it
only through its methods (`addHost`, `addKeyDiscovery`, …), which mark it
dirty; `update_engagement_state` flushes once per successful call. It
survives context summarization and restarts by design — never fold state
fields into a summary.

**WSTG test plan** — the session's OWASP Web Security Testing Guide case list,
persisted on the session document (`webAppTestPlan`) through
`services/web-security/session-plan-store.ts`. The single source of truth is
Mongo: handlers persist there, so anything rendering the plan for the model
must re-read the document rather than trust an in-memory snapshot.

**Engagement boundary** — the declared Target + Scope the scope gate arms
against. One projection and one write in `services/session.helpers.ts`:
`engagementBoundary(session)` reads it (empty-string defaults included) and
`setEngagementBoundary(sessionId, uid, boundary)` writes it (trimming
included). Session info, prompt facts and the plan setup screen all read the
projection; session creation and plan generation write through the verb — no
call site re-derives `engagementContext.*` or the empty-string default.

**Capability install** — the attack-box capability protocol, owned by
`services/capabilities.service.ts`: `installCapability` (OS probe →
privilege-aware install command → apt guard → 10-minute exec → stamp the
user's `installedCapabilities` on success) and `detectCapabilities` (run the
registry's detection script over SSH, parse, stamp). The registry
(`capabilities/`) owns the data — commands, script, parsing; controllers map
HTTP to the two verbs and never exec or write the user config themselves.

## Settings

**Model settings** — every mutation of the model registry, owned by
`services/model-settings.service.ts`: the Settings → Models save
(`saveModels`), the legacy orchestrator upsert
(`assignOrchestratorPreset`), the assignment verbs
(`clearOrchestratorAssignment`, `setBrowserModel`), the subscription
connect (`connectSubscriptionPreset`), and the verification stamp
(`markPresetVerified`). Each verb restores masked api keys (`•` → the
saved secret), applies the verify-on-change rule (a preset whose
credentials moved, or an assigned one that was never verified, is
re-verified before it is saved; an unchanged preset keeps its stamp), and
commits through one place that writes the registry AND clears the
orchestrator's provider cache. Never call `writeModelRegistry` from a
handler, follow it with a hand-rolled `clearProviderCache()`, or re-derive
the masked-key restore at a call site. The persistence layer stays
`utils/modelRegistryStore.ts` (file shape, normalization, legacy
migration); the service owns the mutation protocol. Provider-relevant
`.env` writes go through `applyEnvUpdates` in
`utils/llm/orchestrator.ts` — it writes the file AND clears the provider
cache, so no caller can forget the second half; non-provider env writes
(SSH, Burp RPC) may still use `updateEnvVars` directly. The Settings ->
Models page's pure provider rules (provider options, base URL rules,
model-id slug, assignment set) live in `frontend/src/utils/modelConfig.mjs`.

## Agent run

**Session ownership check** — the one guard behind every controller that
needs only "does this session belong to this user": `requireOwnedSession`
in `services/session.helpers.ts` (and `requireActiveSession` for handlers
that also need the live document). Handlers never write
`SessionsModel.findOne({ sessionId, uid })` by hand.

**Stream message transforms** — the pure message-list reducers for the
agent stream (buffered tool output with the live-char cap, tool_done /
tool_error application, finalizing a streamed assistant message), in
`frontend/src/utils/agentStreamMessages.mjs`. `useAgentStream.js` keeps
only timing (rAF / interval) and store wiring; the transforms are
unit-testable without React.

**Test plan projections** — the pure grouping/filtering/coverage math of
the test plan (`summarise`, `groupCases`, `matchesFilters`,
`caseCarriesWork`), in `frontend/src/utils/testPlan.mjs`. The page only
renders what these return. Status mapping is an explicit table because
stored statuses (`in_progress`) do not match the coverage bucket keys
(`inProgress`). The same module owns the plan table's interaction rules:
`activeSelection`/`toggledSelection`/`selectionWith` (the checkbox set math),
`groupIsOpen` (override → filter → focus → carrying-trouble open policy) and
`coverageChips`. The plan CRUD mutations mirror the scan mutation seam:
`hooks/usePlanMutations.js` owns status update, case edit and the two
removals, and `invalidatePlanCaches` is their one cache-coherence policy
(plan + session info go stale after any write) — never write a plan
`useMutation` with its own invalidation set.

**Context window seam** — the measured transcript projection sent to the
model (token estimators, tool-result elision, `messagesToOpenAI`) lives
in `services/context.service.ts`. The summarization state machine —
`planCompaction`, `summarizeMessages`, `ContextBudget`, the preserve/
summarize split, and the compaction budget constants — lives in
`services/compaction.service.ts` and imports the projection. Mutating
`agentState` outside `agent-state.service.ts` is out of bounds even at
startup (`resetStuckRunningSessions` owns the boot sweep). The
domain-config HTTP handlers live next to their domain controllers:
Burp → `burp.controller.ts`, VNC → `vnc.controller.ts`, Magnitude →
`magnitude.controller.ts`, SSH → `ssh.controller.ts`; `user.controller.ts`
keeps profile/tools/model/OAuth only.

**Agent loop** — the per-user-message orchestration in
`services/agent.service.ts` (`runAgentLoop`): pause/abort polling, context
assembly, LLM call, tool dispatch, persistence. Should stay thin; the
behaviour lives in the modules below.

**Box env probe** — the one-time attack-box detection (user, home, OS,
workspace path) at the start of every agent run, owned by
`services/box-env.ts` (`probeBoxEnv`): the shell round-trip, the `|||`
parse, and the `~`→home workspace resolution. Returns undefined when the
shell is not connected or the probe fails — the prompt then renders
without an env section. The agent loop calls the verb and passes the
result through to the prompt builder.

**Prompt facts** — everything the prompt renders from the session
document: the declared engagement boundary, the WSTG plan + OWASP risk
posture, the user's capability lists, and the run-date facts. Owned by
`services/prompt-facts.ts` (`buildSystemMessage`,
`buildVolatileWebAppForSession`, with `promptFactsFromSession` as the
pure projection). Every call re-reads the document on purpose — tools
mutate the plan and findings mid-run, so never cache the facts or
re-derive the projection at a call site.

**Stream fan-out** — the translation from provider stream deltas to SSE
events, owned by `forwardStreamDelta` in `utils/sse.ts`, next to the
writer and the event catalog. The agent loop's `onDelta` is exactly this
verb; the final text/reasoning come from the invoke result, not from
re-accumulating deltas at the call site. The backend↔frontend half of
the contract (every catalog event consumed by `useAgentStream.js`, no
unknown registrations) is pinned by `backend/tests/sseContract.test.ts` —
the frontend is untyped JS, so that test is the only compile check this
seam gets.

**Transcript** — the session document's message list and everything that
touches it. Owned by `services/session-transcript.ts`: the message
constructors for every role (`userMessage`, `assistantMessage`,
`toolResultMessage`, `systemNoteMessage` — id, timestamp, turnIndex are
stamped in one place), the write verbs (`appendMessages`, `replaceMessages`,
`trackTokens`), the turn opener (`beginTurn` — the user message and the
turnIndex advance as one save), the tool-evidence check
(`sessionUsedTool`), and the run-state reset invariant (`resetAgentRun`:
agentState and pendingConsent go back to idle together). Never hand-build an
`AgentMessageDoc` literal, write a `SessionsModel.updateOne` on
`messages`/`agentState` at a call site, or re-derive a "did the session use
tool X" projection.

**Run buffer** — the agent run's unflushed tail, in `session-transcript.ts`
(`createRunBuffer`). Owns the dual-push discipline (`add` writes the working
transcript AND the tail in one call) and the flush protocol: `flushIfLive` at
every exit path — iteration boundaries, turn endings, and the error path.
Liveness is "the session was not cleared mid-run" (`wasSessionClearedSince`
in `session.helpers.ts`, marked by `resetSessionContext`): a clear is the
only thing that suppresses flushing, because the document was wiped and
pre-clear messages must not be re-appended; a pause or stop still flushes.
`replaceTranscript` swaps the post-compaction transcript and discards the
tail. The loop never keeps a parallel `newMessages` array.

**Stream collector** — the state every LLM provider stream accumulates, in
`utils/llm/streamCollector.ts` (`createStreamCollector`): text/reasoning
parts, the tool-call lifecycle keyed by the provider's own id (start →
argument chunks → `tool_call_done` in start order), the "tool calls imply
finishReason=tool_calls" promotion, and the `join("") || null` result
assembly. The three streaming pipelines in `utils/llm/streaming.ts`
(Anthropic native, OpenAI Responses, chat completions) are event pumps over
it and own only what
genuinely differs per provider (Anthropic's usage merge, Responses' item ids
and `arguments.done`, chunk-level usage/model). Never add a fourth pipeline
that re-derives the lifecycle.

**Slash reply** — the slash-command reply protocol, owned by
`services/slash-reply.ts` (`createSlashReply`): every command terminates with
`slash_command_result` → `done` → `end()`, command name stamped once.
Handlers take a `SlashReply` (`ok`/`fail`/`sessionMissing`/`ack`/`stream`),
never a raw `SSEWriter` — forget one `end()` and the HTTP stream hangs open.
The session lookup shares that shape: handlers that read the session go
through the handler ctx's `loadSession` (lookup + `sessionMissing` guard in
one place, errors left to `executeSlashCommand`'s catch); only `/map` and
`/report` keep their own `select()` projections, with the same
missing-session guard.

**Context budget** — the per-run compaction state machine in
`services/compaction.service.ts` (`ContextBudget`): the cached prompt size, the
plan decision, and the invariant that a compaction resets the cached size to
the post-compaction projection (the anti-thrashing guard against
summarize → one tool → summarize loops).

**VNC config** — the stored VNC settings (`VNC_*` env keys), owned by
`services/vnc-provisioning.service.ts`: `getVncConfig` (the one
projection — handlers never re-read the raw env keys),
`updateVncConfig`/`resetVncConfig`, and `completeAutoProvision` (the
stamp written when the one-click setup finishes). All writes go through
these verbs.

**Volatile tail** — the `<volatile_system>` block appended after the static
system prompt (run clock, engagement state, WSTG plan + OWASP posture). Owned
by `utils/assistant/volatileContext.ts`, split off again by the Anthropic
adapter so the static prefix stays prompt-cached. The marker string has no
owner other than that module.

**Tool readiness** — whether a tool's external dependency (env, assigned
model, API key) is configured. Declared per tool by `checkReady` in its
`ToolDefinition`; aggregated by `getUnconfiguredToolNames()`. The schema
filter, the run path and the prompt builder all consume that one seam — never
re-derive readiness from env reads elsewhere.

**Trace tags** — the dynamic tags for an LLM call (plan vs analyze phase,
which tools just ran), in `utils/traceTags.ts` (`buildTraceTags`). Pure and
unit-tested; the loop passes the result straight to the invoke call.

**Test plan renderers** — the shared prompt/tool-output vocabulary of the
plan, in `services/web-security/test-plan.service.ts`:
`describeCoverage` (the one coverage sentence the tool replies and the
prompt section both read), `describeCase` (the one-line case name),
`normalizeTestCasePatch` and `normalizePlanGenerateInput` (the raw → patch/input
translation with the snake_case/camelCase aliases resolved once). The
`wstg_test_plan` handler and the web-security controller dispatch through
these; never hand-build a patch object or re-format the coverage sentence at
a call site.

**Session activity** — the chat page's readout projection (tool-call totals,
per-tool top rows, wall-clock span), in `frontend/src/utils/sessionActivity.mjs`
(`summariseSessionActivity`, `formatElapsed`, `toolCallState`). Pure and
tested; ChatView only renders it.

**Burp handoff** — the cross-page protocol that carries a Burp-captured
request into the chat composer, owned by `frontend/src/utils/burpHandoff.mjs`:
`BURP_HANDOFF_KEY` (the one sessionStorage key), `takeBurpHandoff`
(read-remove-parse once) and `buildBurpMessage` (the prompt text +
`burpMeta`). The proxy page writes the key; ChatView consumes it — neither
re-derives the payload format.

**Orchestrator resolution** — "which model orchestrates for this user", one
verb in `utils/llm/orchestrator.ts` (`resolveOrchestrator`): the assigned
orchestrator (verified, host-owner-restricted) or the env default, returned
as a ready `ProviderConfig` plus its reasoning mode, fresh on every call.
The module also owns the per-invocation resolution
(`resolveInvocationProvider`: override wins, subscriptions refuse
non-owners) and the 30s cache behind the env default (`getProvider` —
budget math without a user context). The per-user invocation path never
re-derives the fallback chain, the verification check, or the
reasoning-mode cast.

**Consent batch** — the group of tool calls parked when the approval gate
stops a turn (`pendingConsent` on the session document, `consentStats` for the
counters). Owned by `services/consent-batch.ts`: the batch shape
(`buildPendingConsentBatch`), the batch-vs-single persistence rule
(`persistPendingConsent`), the `consent_required` SSE payload, the resume-side
unpack (`loadPendingConsent`), the per-item split (`splitConsentBatch`), and the
counters (`recordConsentOutcome`, `recordCircuitOpen`). Never hand-build the
pendingConsent document shape, re-derive `arguments` with parseToolArguments at
a call site, or `$inc` a `consentStats` counter outside the module.

The split has one asymmetry that is load-bearing: `approvedToolCallIds`
**omitted** means "the whole batch" and **empty** means "none of it". A batch
that parks on a read-only probe next to a boundary-crossing install is the
normal case, so the operator may approve one and refuse the other; each refusal
is answered with a denial tool result so the model is never left waiting, and a
mixed response counts as an approval for the rejection-streak circuit breaker.
An empty list must never widen into "run everything" — it is what a
mis-rendered checkbox list sends.

**Context window rules** — the elision policy for what reaches the model:
staleness window (`isStaleMessage`), tool-result/args caps
(`toolResultCap`, `elideToolResult`, `elideToolCallArgs`), the reasoning
replay window, and the conversation input bounding for LLM calls that receive
the whole history (`boundedConversationText`). The first three live in
`services/context.service.ts` (with the token estimator, `messagesToOpenAI`,
and the /summarize and /export projections); `boundedConversationText` lives
in `services/compaction.service.ts` beside the summarizer that built it. Never
write the caps or the window arithmetic a second time — `estimateMessageTokens`
and `messagesToOpenAI` share these helpers so the budget can never drift from
what the prompt actually sends.

**Finding store** — the finding lifecycle in`services/vulnerability.service.ts`: `recordSessionFinding` (resolve plan case
→ normalize → filter screenshots → classify → upsert → link, in that order —
recording a finding against a WSTG case IS the failed result) and
`removeSessionFinding` (unlink cases BEFORE pulling the document). The OWASP
classification write is also owned here: `applyOwaspMapping` is the one
`vulnerabilities.$...` positional $set (mapping stamp + wstgId→catalog title/
category resolution, the finding's previous values as fallback). Tools, the
mapping endpoints and the batch re-classifier call these verbs; they never
touch the vulnerabilities array shape, re-order the chain, or build the
array update themselves.

**Scan (WSTG)** — one execution of a set of test-plan cases, launched from the
web UI rather than by prompting the agent. The product vocabulary is "scan"
(frontend routes `/session/<id>/scans`, its own list and detail pages); the
storage vocabulary stays "run" — a scan is a `webAppRuns` record on the session
document, and the engine is
`services/web-security/run-queue.service.ts` (`enqueueRun`, `pump`, `stopRun`,
`deleteRun`, `parkedRunContext`). A launch carries a `policy`: `unattended`
(the default, which passes `toolExecutionMode: "auto_approve"` into
`initAndRun` so the existing Approve-for-me reviewer clears approval
boundaries) or `supervised` (leave the user's own mode in charge, so the scan
may park on consent and wait on its own page). A parked scan keeps both halves
of that identity across the resume — `parkedRunContext` hands the consent
continuation the scan's own channel and mode — so an unattended scan does not
silently become supervised, and its activity never leaks into the chat feed.
The agent's gates are never bypassed by either policy: a destructive action
against the target is still refused outright.

`scan-results.ts` owns every pure projection the scan pages read: `selectRuns`
(the history a view shows), `decorateRun` (its queue position — through
`queuePosition`, the one counting rule the launch response also answers with —
its liveness, and its policy, normalized so no surface re-derives the
pre-policy default), `joinRunResults` (the case rows, findings and severity
histogram the list and the detail page both read), `sliceRunActivity` plus the
`[WSTG run <runId>]` marker itself (`runMarker`/`isRunMarker`, which
`buildRunInstruction` renders), and `runPolicy`/`normalizeRunLabel`. All of it
is what the tests exercise. One deliberate exception to "one copy of a result":
a settled scan keeps the plan statuses it recorded (`resultSummary`, written by
`snapshotRunResult`) and the list reads *that*, because history must not
rewrite itself when a later scan changes a case — the plan stays the live truth
and the detail page's progress reads it, scoped to the cases this scan touched
(`updatedAt >= startedAt`, so a re-test does not open at 100%).

On the frontend the same discipline holds: `utils/scans.mjs` is the pure
vocabulary (what a scan is called, whether it is live via `isScanLive` — the
one predicate every poll, badge and animation keys off — its scope line,
folder counts, failure groups, search, and the case selection rules
`resolveScanSelection`/`isUnrunCase`), and `hooks/useScanMutations.js` owns the
mutation seam: launch, stop and delete go through it, and
`invalidateScanCaches` is the one cache-coherence policy (the scan detail poll,
the list and the test plan all go stale after any scan write; a deleted scan's
detail cache is removed outright; a launch also marks the chat history stale).
Query keys come from `utils/scanQueryKeys.mjs` (`scansKey`, `scanKey`,
`testPlanKey`) — never hand-build a `["scans", sessionId]` literal, and never
write a second launch/stop/delete `useMutation` with its own invalidation set.

## Web surface

**Page frame** — the shell every product screen renders inside, owned by
`components/common/ui/PageShell.jsx` + `PageHeader.jsx` + `PageState.jsx` and
`styles/components/Page.module.scss`. The frame owns the scroll region, the
reading measure, the responsive padding, the title/action block and the three
data states (loading, empty, error-with-retry). A page owns only what is inside
it: it never declares its own page padding, never borrows another page's shell
class (that is how the case page inherited a flex column with
`overflow: hidden` and lost the bottom of its report), and never hand-rolls a
spinner-plus-paragraph empty state. `PRODUCT.md` holds the route map and the
rules the frame exists to keep.

**Engagement overview** — the session root (`/session/<sessionId>`), owned by
`components/pages/session/overview/EngagementOverviewPage.jsx`. It reads the
plan, the scans and the findings through the same react-query keys their own
pages use, so the rail, the overview and the pages share one poll per resource.
Chat is deliberately *not* the root: it lives at `/session/<sessionId>/chat`,
and anything handing work to the chat composer (the Burp "send to workspace"
handoff, for one) must target that path rather than the session root.

