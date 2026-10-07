/**
 * Nessus-style scan queue for WSTG cases launched from the web UI.
 *
 * The product concept is a **scan**: the operator picks a set of WSTG cases
 * (and how much approval the scan may assume) and launches it. This module is
 * the engine behind that concept, so it keeps the storage vocabulary — every
 * scan is a run record persisted on the session document (`webAppRuns`), so
 * history survives reload and restart the way the test plan itself does.
 *
 * A per-session in-memory FIFO feeds those records into the agent loop one at
 * a time: when the agent is idle the head record starts a detached run (no SSE
 * client — the UI follows along by polling the run's transcript slice), and
 * when the agent is busy the record stays queued until a run of any kind
 * releases its abort-controller slot.
 *
 * The agent's own safety gates are untouched: a queued scan goes through the
 * same system prompt, boundary checks and consent rules as a chat message. An
 * `unattended` scan only swaps the *human* for the existing Approve-for-me
 * reviewer, exactly the way the user's own "auto_approve" mode does.
 */

import { randomUUID } from "node:crypto";

import SessionsModel from "../../models/Sessions/Sessions.model";
import type {
  AgentMessageDoc,
  SessionTestCaseDoc,
  SessionVulnerabilityDoc,
  WebAppRunDoc,
  WebAppRunPolicy,
  WebAppRunStatus,
} from "../../models/Sessions/Sessions.model";
import type { ToolExecutionMode } from "../../models/User/User.model";
import {
  buildResultSummary,
  decorateRun,
  normalizeRunLabel,
  runCaseRows,
  runFindings,
  runPolicy,
  selectRuns,
  sliceRunActivity,
  type RunCaseRow,
  type RunFindingRow,
  type RunListItem,
  type RunListFilter,
} from "./scan-results";
import { createDetachedSSEWriter } from "../../utils/sse";
import { initAndRun } from "../agent.service";
import {
  abortSession,
  hasActiveController,
  releaseAbortController,
  reserveAbortController,
} from "../agent-controller-registry";
import { setAgentState, setPaused } from "../agent-state.service";
import { resetAgentRun } from "../session-transcript";
import { sessionLifecycle } from "../session.lifecycle";
import { loadSessionPlan } from "./session-plan-store";
import { buildRunInstruction, findPlanCase } from "./test-plan.service";

interface SessionQueueState {
  queue: string[];
  activeRunId: string | null;
  /** The owner of the enqueued runs, needed by initAndRun at pump time. */
  userId?: string;
}

const queueStates = new Map<string, SessionQueueState>();

function stateFor(sessionId: string): SessionQueueState {
  let state = queueStates.get(sessionId);
  if (!state) {
    state = { queue: [], activeRunId: null };
    queueStates.set(sessionId, state);
  }
  return state;
}

// ─── Run record persistence (webAppRuns on the session document) ──────

async function loadRuns(sessionId: string): Promise<WebAppRunDoc[]> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("webAppRuns")
    .lean();
  return (session?.webAppRuns as WebAppRunDoc[] | undefined) ?? [];
}

async function saveRuns(sessionId: string, runs: WebAppRunDoc[]): Promise<void> {
  const result = await SessionsModel.updateOne(
    { sessionId },
    { $set: { webAppRuns: runs } },
  );
  if (!result.matchedCount) {
    throw new Error("Session not found while saving the WSTG run record");
  }
}

async function mutateRun(
  sessionId: string,
  runId: string,
  mutate: (run: WebAppRunDoc) => void,
): Promise<WebAppRunDoc | null> {
  const runs = await loadRuns(sessionId);
  const run = runs.find((entry) => entry.runId === runId);
  if (!run) return null;
  mutate(run);
  await saveRuns(sessionId, runs);
  return run;
}

// ─── Launch ───────────────────────────────────────────────────────────

export interface EnqueueRunInput {
  sessionId: string;
  userId: string;
  testIds: string[];
  label?: string;
  /** Defaults to unattended: a launched scan is expected to finish on its own. */
  policy?: WebAppRunPolicy;
}

export type EnqueueRunResult =
  | { ok: true; run: WebAppRunDoc; position: number }
  | { ok: false; missing: string[] };

/**
 * Validates the requested test ids against the plan, appends a queued scan
 * record and tries to start it immediately if the agent is idle.
 */
export async function enqueueRun(input: EnqueueRunInput): Promise<EnqueueRunResult> {
  const plan = await loadSessionPlan(input.sessionId);
  if (!plan) return { ok: false, missing: input.testIds };

  const requested = input.testIds.map((testId) => testId.trim().toUpperCase());
  const missing = requested.filter(
    (testId) => !findPlanCase(plan, testId),
  );
  if (missing.length) return { ok: false, missing };

  const run: WebAppRunDoc = {
    runId: randomUUID(),
    testIds: requested,
    label: normalizeRunLabel(input.label),
    status: "queued",
    policy: input.policy ?? "unattended",
    triggeredBy: "ui",
    queuedAt: new Date(),
  };

  const runs = await loadRuns(input.sessionId);
  runs.push(run);
  await saveRuns(input.sessionId, runs);

  // A launch from the web UI is an explicit "run now": a chat the user paused
  // earlier must not hold the queue hostage, so clear the parked state before
  // pumping. A genuinely busy agent keeps its slot (pump reserves properly).
  const parked = await SessionsModel.findOne({ sessionId: input.sessionId })
    .select("agentState")
    .lean();
  if ((parked?.agentState as string | undefined) === "paused") {
    await setPaused(input.sessionId, false).catch(() => {});
    await setAgentState(input.sessionId, "idle").catch(() => {});
  }

  const state = stateFor(input.sessionId);
  state.queue.push(run.runId);
  state.userId = input.userId;
  await pump(input.sessionId);

  // The same counting rule the list uses (see scan-results.decorateRun), so a
  // launch never answers "position 1" about a scan the list calls "#2".
  const ahead = state.activeRunId ? 1 : 0;
  return {
    ok: true,
    run,
    position: ahead + state.queue.indexOf(run.runId) + 1,
  };
}

// ─── Queue pump ───────────────────────────────────────────────────────

/**
 * Starts the next queued run when the agent slot is free. Called after every
 * enqueue and after any agent run releases its controller slot (chat, resume,
 * consent or one of ours), so a queue never stalls.
 */
export async function pump(sessionId: string): Promise<void> {
  const state = stateFor(sessionId);
  if (state.activeRunId) return;

  const session = await SessionsModel.findOne({ sessionId })
    .select("agentState")
    .lean();
  const agentState = session?.agentState as string | undefined;
  // A run parked on consent, or a chat the user paused, still owns the
  // transcript: starting the next run now would race the continuation.
  if (agentState === "waiting_consent" || agentState === "paused") return;

  // Any record still marked "running" with no active run and a settled agent
  // state is the tail of a consent continuation that just finished (or was
  // abandoned) — finalise it before the queue moves on.
  const runs = await loadRuns(sessionId);
  const orphan = runs.find((entry) => entry.status === "running");
  if (orphan) {
    await settleRun(sessionId, orphan.runId, agentState);
  }

  while (state.queue.length) {
    const runId = state.queue[0];
    const run = runs.find((entry) => entry.runId === runId);
    if (!run || run.status !== "queued") {
      state.queue.shift();
      continue;
    }

    const abortCtrl = reserveAbortController(sessionId);
    if (!abortCtrl) return; // agent busy — head stays queued, retried on release

    state.queue.shift();
    state.activeRunId = runId;
    startRun(sessionId, state, run, abortCtrl).catch((err) => {
      console.error(`[wstg-run] run ${runId} failed to start:`, err);
    });
    return;
  }
}

async function startRun(
  sessionId: string,
  state: SessionQueueState,
  run: WebAppRunDoc,
  abortCtrl: AbortController,
): Promise<void> {
  try {
    const plan = await loadSessionPlan(sessionId);
    if (!plan) throw new Error("Session has no WSTG test plan");

    const cases = run.testIds
      .map((testId) => findPlanCase(plan, testId))
      .filter((testCase) => testCase != null);
    if (!cases.length) throw new Error("None of the run's cases are in the plan");

    await mutateRun(sessionId, run.runId, (record) => {
      record.status = "running";
      record.startedAt = new Date();
    });

    const instruction = buildRunInstruction(run.runId, cases, {
      target: plan.target,
      scope: plan.scope,
      policy: runPolicy(run),
    });

    // The loop polls a Redis pause flag the chat's pause button sets; a stale
    // flag from an earlier paused chat would end this run before its first
    // token. A run the user launched must actually run.
    await setPaused(sessionId, false).catch(() => {});

    // The loop reports failures as an `error` event rather than a throw;
    // capture it so a provider/tool failure settles the record as failed
    // instead of a silent "completed with no result".
    let runError: string | undefined;
    const sse = createDetachedSSEWriter("wstg-run", (message) => {
      runError ??= message;
    });

    await initAndRun({
      sessionId,
      userId: state.userId ?? "",
      userMessage: instruction,
      sse,
      abortSignal: abortCtrl.signal,
      // Runs live in their own transcript channel: the model sees the history,
      // the chat page's feed does not — the run is watched on the scan page.
      channel: "run",
      // Unattended scans hand approval-boundary actions to the same reviewer
      // the user's "Approve for me" mode uses; supervised scans leave the
      // setting alone so their own mode decides (and may park for a human).
      toolExecutionMode:
        runPolicy(run) === "unattended" ? "auto_approve" : undefined,
    });

    await finishRun(sessionId, state, run.runId, abortCtrl, runError);
  } catch (err: any) {
    console.error(`[wstg-run] run ${run.runId} error:`, err);
    await finishRun(sessionId, state, run.runId, abortCtrl, err?.message);
  }
}

/**
 * The detached counterpart of the controller's releaseAfterRun: free the
 * controller slot, arm the shell idle timer, and settle the run record —
 * unless the loop parked on a consent request, in which case the record stays
 * "running" and the consent continuation (approved from here or from the
 * chat) settles it via pump's orphan finalisation.
 */
async function finishRun(
  sessionId: string,
  state: SessionQueueState,
  runId: string,
  abortCtrl: AbortController,
  errorMessage?: string,
): Promise<void> {
  if (state.activeRunId === runId) state.activeRunId = null;
  releaseAbortController(sessionId, abortCtrl);
  if (sessionLifecycle.hasShellManager(sessionId)) {
    sessionLifecycle.scheduleDestroy(sessionId);
  }

  try {
    const session = await SessionsModel.findOne({ sessionId })
      .select("agentState")
      .lean();
    const agentState = session?.agentState as string | undefined;
    if (agentState === "waiting_consent") {
      await pump(sessionId); // no-op while consent is pending; see pump guard
      return;
    }
    await settleRun(sessionId, runId, agentState, abortCtrl.signal.aborted, errorMessage);
  } catch (err) {
    console.error(`[wstg-run] failed to finalise run ${runId}:`, err);
  }

  await pump(sessionId);
}

/**
 * Close out a run record: completed / cancelled / failed per how its loop
 * ended, duration stamped, and the per-case result snapshot copied from the
 * plan. Abort parks the loop at "paused"; with no chat client to resume a
 * stopped run, the agent state is reset so the UI and the next queued run
 * start clean.
 */
async function settleRun(
  sessionId: string,
  runId: string,
  agentState?: string,
  aborted?: boolean,
  errorMessage?: string,
): Promise<void> {
  let settled: WebAppRunStatus = "completed";
  if (aborted) settled = "cancelled";
  else if (errorMessage) settled = "failed";

  try {
    await mutateRun(sessionId, runId, (run) => {
      if (run.status !== "running") return; // already stopped/cancelled explicitly
      run.status = settled;
      run.finishedAt = new Date();
      run.durationMs = run.startedAt
        ? run.finishedAt.getTime() - run.startedAt.getTime()
        : undefined;
      if (errorMessage) run.error = errorMessage;
    });
    await snapshotRunResult(sessionId, runId);
  } catch (err) {
    console.error(`[wstg-run] failed to settle run ${runId}:`, err);
  }

  if (settled === "cancelled") {
    await setPaused(sessionId, false).catch(() => {});
    await setAgentState(sessionId, "idle").catch(() => {});
  } else if (agentState === "running") {
    // A continuation or loop that ended without writing its own idle state.
    await setAgentState(sessionId, "idle").catch(() => {});
  }
}

/** Copy each case's current plan status into the finished run record. */
export async function snapshotRunResult(
  sessionId: string,
  runId: string,
): Promise<void> {
  const [plan, runs] = await Promise.all([
    loadSessionPlan(sessionId),
    loadRuns(sessionId),
  ]);
  const run = runs.find((entry) => entry.runId === runId);
  if (!run) return;

  const summary = buildResultSummary(
    run.testIds,
    plan?.cases.map((testCase) => ({
      testId: testCase.testId,
      status: testCase.status,
    })) ?? null,
  );

  await mutateRun(sessionId, runId, (record) => {
    record.resultSummary = summary;
  });
}

// ─── Stop / cancel ────────────────────────────────────────────────────

/** Abort a running run (the loop unwinds and pump settles the record). */
export async function stopRun(sessionId: string, runId: string): Promise<boolean> {
  const runs = await loadRuns(sessionId);
  const run = runs.find((entry) => entry.runId === runId);
  if (!run) return false;

  if (run.status === "running") {
    if (hasActiveController(sessionId)) {
      // The loop is live: abort it and let finishRun settle the record.
      abortSession(sessionId);
      return true;
    }
    // A run parked on consent released its controller, so there is nothing to
    // abort. Stopping it means clearing the park and closing the record here —
    // otherwise the only way out of a parked scan is to answer it.
    await resetAgentRun(sessionId).catch(() => {});
    await settleRun(sessionId, runId, "idle", true);
    await pump(sessionId);
    return true;
  }
  if (run.status === "queued") {
    return cancelQueuedRun(sessionId, runId);
  }
  return false;
}

/** Remove a queued run before it starts; it stays in history as cancelled. */
export async function cancelQueuedRun(
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const state = stateFor(sessionId);
  let cancelled = false;
  await mutateRun(sessionId, runId, (record) => {
    if (record.status !== "queued") return;
    record.status = "cancelled";
    record.finishedAt = new Date();
    cancelled = true;
  });
  if (!cancelled) return false;
  state.queue = state.queue.filter((entry) => entry !== runId);
  return true;
}

/**
 * Delete a scan from the history: a queued one is dropped along with its queue
 * slot, a settled one is removed from the document. A running scan must be
 * stopped first.
 *
 * The removal is one atomic `$pull` guarded on the status, because deciding
 * from a read and then writing the whole array back would let a scan that
 * started in between be deleted while its detached agent kept running — an
 * invisible run.
 */
export async function deleteRun(sessionId: string, runId: string): Promise<boolean> {
  const state = stateFor(sessionId);
  const runs = await loadRuns(sessionId);
  const run = runs.find((entry) => entry.runId === runId);
  if (!run || run.status === "running" || state.activeRunId === runId) return false;

  const result = await SessionsModel.updateOne(
    { sessionId, webAppRuns: { $elemMatch: { runId, status: { $ne: "running" } } } },
    { $pull: { webAppRuns: { runId } } },
  );
  if (!result.modifiedCount) return false;

  state.queue = state.queue.filter((entry) => entry !== runId);
  return true;
}

// ─── Reads for the UI ─────────────────────────────────────────────────

/** All runs, newest first, with the live queue position filled in. */
export async function listRuns(
  sessionId: string,
  filter: RunListFilter = {},
): Promise<RunListItem[]> {
  const [runs, state] = [await loadRuns(sessionId), stateFor(sessionId)];
  return selectRuns(runs, filter).map((run) => decorateRun(run, state));
}

export interface ParkedRunContext {
  runId: string;
  /** The transcript channel the scan writes in. */
  channel: string;
  /** The approval mode the scan was launched with, for its continuation. */
  toolExecutionMode?: ToolExecutionMode;
}

/**
 * Which scan a parked consent belongs to, for the resume path.
 *
 * A supervised scan parks and releases its controller; when the user answers,
 * the continuation must run under the scan's own rules again — its transcript
 * channel (or its activity leaks into the chat feed) and its approval mode (or
 * an unattended scan silently becomes supervised for the rest of its cases).
 * Returns null when the parked consent is a chat's, which changes nothing.
 */
export async function parkedRunContext(
  sessionId: string,
): Promise<ParkedRunContext | null> {
  const state = stateFor(sessionId);
  const runs = await loadRuns(sessionId);
  const run = runs.find((entry) =>
    state.activeRunId ? entry.runId === state.activeRunId : entry.status === "running",
  );
  if (!run) return null;

  return {
    runId: run.runId,
    channel: "run",
    toolExecutionMode:
      runPolicy(run) === "unattended" ? "auto_approve" : undefined,
  };
}

export interface RunActivityMessage {
  id: string;
  role: string;
  content: string | null;
  reasoning?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  toolName?: string;
  files?: string[];
  timestamp: Date;
}

export interface RunDetail {
  run: RunListItem | null;
  agentState?: string;
  pendingConsent?: Record<string, unknown> | null;
  messages: RunActivityMessage[];
  /** The scan's own results, so the detail page reads as one document. */
  cases: RunCaseRow[];
  findings: RunFindingRow[];
}

/**
 * One run plus its transcript slice and its joined results: everything from
 * the run's marker user message until the next run's marker (or the end).
 * Serves both live polling and replay of finished runs.
 */
export async function getRunDetail(
  sessionId: string,
  runId: string,
): Promise<RunDetail> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("webAppRuns messages agentState pendingConsent webAppTestPlan vulnerabilities")
    .lean();
  if (!session) {
    return { run: null, messages: [], cases: [], findings: [] };
  }

  const runs = (session.webAppRuns as WebAppRunDoc[] | undefined) ?? [];
  const record = runs.find((entry) => entry.runId === runId);
  const state = stateFor(sessionId);

  const slice = sliceRunActivity(
    (session.messages ?? []) as AgentMessageDoc[],
    runId,
  );

  const plan = session.webAppTestPlan as { cases?: SessionTestCaseDoc[] } | undefined;
  const cases = runCaseRows(record?.testIds ?? [], plan?.cases ?? null);
  const findings = runFindings(
    cases,
    (session.vulnerabilities as SessionVulnerabilityDoc[] | undefined) ?? null,
  );

  // Consent belongs to whichever run the agent is actually executing — a run
  // waiting in line must not surface someone else's approval request.
  const ownsConsent =
    !!record &&
    record.status === "running" &&
    (state.activeRunId === runId || !state.activeRunId);

  return {
    run: record ? decorateRun(record, state) : null,
    agentState: session.agentState as string | undefined,
    pendingConsent: ownsConsent
      ? (session.pendingConsent as Record<string, unknown> | null | undefined) ?? null
      : null,
    messages: slice.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      toolCalls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      })),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      files: message.files,
      timestamp: message.timestamp,
    })),
    cases,
    findings,
  };
}

// ─── Boot recovery ────────────────────────────────────────────────────

/**
 * Server restarts interrupt detached runs with no trace. Mark runs that were
 * mid-flight as failed, and re-arm the queue for runs still waiting so a
 * restart does not silently swallow them.
 */
export async function recoverStaleRuns(): Promise<void> {
  const sessions = await SessionsModel.find({
    "webAppRuns.status": { $in: ["running", "queued"] },
  })
    .select("sessionId uid agentState webAppRuns")
    .lean();

  for (const session of sessions) {
    const sessionId = session.sessionId as string;
    const runs = (session.webAppRuns ?? []) as WebAppRunDoc[];
    let changed = false;
    for (const run of runs) {
      if (run.status === "running") {
        run.status = "failed";
        run.error = "Interrupted by a server restart";
        run.finishedAt = run.finishedAt ?? new Date();
        changed = true;
      }
    }
    if (changed) {
      await saveRuns(sessionId, runs).catch((err) =>
        console.error(`[wstg-run] recovery save failed for ${sessionId}:`, err),
      );
    }
    // No controller can exist at boot, so a parked consent or pause belongs to
    // a dead run — clear it or it blocks the queue's pump forever.
    const agentState = (session as any).agentState;
    if (agentState === "waiting_consent" || agentState === "paused") {
      await resetAgentRun(sessionId).catch((err) =>
        console.error(`[wstg-run] recovery state reset failed for ${sessionId}:`, err),
      );
    }

    const state = stateFor(sessionId);
    state.userId = String(session.uid);
    state.queue = runs
      .filter((run) => run.status === "queued")
      .map((run) => run.runId);
    if (state.queue.length) {
      await pump(sessionId).catch((err) =>
        console.error(`[wstg-run] recovery pump failed for ${sessionId}:`, err),
      );
    }
  }
}
