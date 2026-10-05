# GLOSSARY

Domain and seam vocabulary for this codebase. The architecture vocabulary
(module, interface, depth, seam, adapter, leverage, locality) follows
`.zcode/skills/codebase-design/SKILL.md`. This file names the concepts that
recurred often enough to earn a seam — use these names when touching the areas
below, and add a term here when a refactor gives a concept a module of its own.

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
migration); the service owns the mutation protocol.

## Agent run

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
`services/context.service.ts` (`ContextBudget`): the cached prompt size, the
plan decision, and the invariant that a compaction resets the cached size to
the post-compaction projection (the anti-thrashing guard against
summarize → one tool → summarize loops).

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
unpack (`loadPendingConsent`), and the counters (`recordConsentOutcome`,
`recordCircuitOpen`). Never hand-build the pendingConsent document shape,
re-derive `arguments` with parseToolArguments at a call site, or `$inc` a
`consentStats` counter outside the module.

**Context window rules** — the elision policy for what reaches the model:
staleness window (`isStaleMessage`), tool-result/args caps
(`toolResultCap`, `elideToolResult`, `elideToolCallArgs`), the reasoning
replay window, and the conversation input bounding for LLM calls that receive
the whole history (`boundedConversationText`), all in
`services/context.service.ts`. The token estimator, `messagesToOpenAI`, and
the /summarize and /export commands all consume these helpers — never write
the caps or the window arithmetic a second time.

**Finding store** — the finding lifecycle in
`services/vulnerability.service.ts`: `recordSessionFinding` (resolve plan case
→ normalize → filter screenshots → classify → upsert → link, in that order —
recording a finding against a WSTG case IS the failed result) and
`removeSessionFinding` (unlink cases BEFORE pulling the document). Tools and
report paths call these two verbs; they never touch the vulnerabilities array
shape or re-order the chain.
