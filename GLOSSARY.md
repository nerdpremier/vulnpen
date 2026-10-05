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

## Agent run

**Agent loop** — the per-user-message orchestration in
`services/agent.service.ts` (`runAgentLoop`): pause/abort polling, context
assembly, LLM call, tool dispatch, persistence. Should stay thin; the
behaviour lives in the modules below.

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

**Consent batch** — the group of tool calls parked when the approval gate
stops a turn (`pendingConsent` on the session document, `consentStats` for the
counters). Resumed by `handleConsent`.
