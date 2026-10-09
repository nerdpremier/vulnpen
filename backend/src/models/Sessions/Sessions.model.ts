import mongoose from "mongoose";

import type { WstgTestStatus } from "../../knowledge/types";
import type { EngagementStateSnapshot } from "../../services/engagement-state";

const Schema = mongoose.Schema;

// ─── Message types (mirrors OpenAI chat completion message format) ────

export interface AgentToolCallData {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentMessageDoc {
  _id?: mongoose.Types.ObjectId;
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning?: string;
  toolCalls?: AgentToolCallData[];
  toolCallId?: string;
  toolName?: string;
  /** Server-side artifact filenames (e.g. browser screenshots) the UI renders inline. */
  files?: string[];
  timestamp: Date;
  turnIndex: number;
  isSummary?: boolean;
  /** Transcript channel — undefined = main chat, "run" = a UI-launched WSTG run. */
  channel?: string;
}

export interface PendingConsentToolCall {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
  safetyBlock?: boolean;
  approvalReason?: string;
  safetyReason?: string;
  safetyImpact?: string;
  safetyKind?: "dangerous" | "destructive_target" | "out_of_scope";
}

export interface PendingConsentDoc {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
  safetyBlock?: boolean;
  approvalReason?: string;
  safetyReason?: string;
  safetyImpact?: string;
  safetyKind?: "dangerous" | "destructive_target" | "out_of_scope";
  batch?: PendingConsentToolCall[];
}

export interface ConsentStatsDoc {
  prompts: number;
  approvals: number;
  denials: number;
  safetyBlocks: number;
  circuitOpens: number;
}

export type AgentState =
  | "idle"
  | "running"
  | "paused"
  | "waiting_consent";

export type ShellType = "pty" | "exec";
export type ShellStatus = "active" | "closed";
export type ShellCreator = "user" | "agent" | "subagent";

export interface ShellDoc {
  shellId: string;
  label: string;
  type: ShellType;
  status: ShellStatus;
  createdBy: ShellCreator;
  subagentId?: string;
  createdAt: Date;
  closedAt?: Date;
}

export type SubagentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export interface SubagentDoc {
  subagentId: string;
  parentId: string;
  task: string;
  status: SubagentStatus;
  result?: string;
  messages: AgentMessageDoc[];
  shells: string[];
  createdAt: Date;
  completedAt?: Date;
}

export interface ConnectionStateDoc {
  sshConnected: boolean;
  hostConnected?: boolean;
  hostKind?: "local" | "ssh";
  lastConnectedAt?: Date;
  lastError?: string;
}

export interface EngagementContextDoc {
  target?: string;
  scope?: string;
  credentials?: string;
  labels?: string[];
  metadata?: Record<string, string>;
}

export interface VulnerabilityChatMessageDoc {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/** Lifecycle of a single OWASP WSTG v4.2 test case tracked in a session plan. */
export type SessionTestCaseStatus = WstgTestStatus;

export interface SessionTestCaseDoc {
  testId: string;
  section: string;
  categoryCode: string;
  categoryName: string;
  title: string;
  objective: string;
  howToTest: string;
  tools: string[];
  evidenceExpectation: string;
  status: SessionTestCaseStatus;
  notes: string;
  observations: string;
  linkedVulnerabilityIds: string[];
  updatedAt: Date;
}

/** The WSTG v4.2 test plan the assistant is working through in this session. */
export interface WebAppTestPlanDoc {
  source: string;
  version: string;
  target: string;
  scope: string;
  categories: string[];
  cases: SessionTestCaseDoc[];
  createdAt: Date;
  updatedAt: Date;
}

/** Lifecycle of one Nessus-style execution of a set of WSTG cases. */
export type WebAppRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * How much the scan asks of the operator while it runs.
 *
 * `unattended` reviews approval-boundary actions with the Approve-for-me
 * reviewer so a launched scan finishes on its own; `supervised` leaves the
 * user's own tool-execution mode in charge, which parks the scan on the first
 * boundary action and waits for a human.
 */
export type WebAppRunPolicy = "unattended" | "supervised";

export interface WebAppRunCaseResult {
  testId: string;
  status: WstgTestStatus;
}

export interface WebAppRunDoc {
  runId: string;
  testIds: string[];
  label: string;
  status: WebAppRunStatus;
  /** Absent on records written before scans had a policy: read it as unattended. */
  policy?: WebAppRunPolicy;
  triggeredBy: "ui";
  queuedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  /** Snapshot of every case's status when the run settled. */
  resultSummary?: {
    perCase: WebAppRunCaseResult[];
    counts: { passed: number; failed: number; blocked: number; other: number };
  };
  error?: string;
}
export interface SessionVulnerabilityDoc {
  vulnerabilityId: string;
  fingerprint: string;
  title: string;
  host: string;
  service?: string;
  endpoint?: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  cwe?: string;
  cve?: string;
  description?: string;
  evidence: string;
  stepsToReproduce: string[];
  contextSummary: string;
  impact?: string;
  remediation?: string;
  exploited: boolean;
  source: string;
  /** OWASP WSTG v4.2 test case that produced this finding, e.g. "WSTG-INPV-05". */
  wstgId?: string;
  wstgTitle?: string;
  wstgCategory?: string;
  /** OWASP Top 10:2025 classification, e.g. "A05:2025". */
  owaspTop10?: string;
  owaspTop10Title?: string;
  owaspRelated?: string[];
  owaspConfidence?: "high" | "medium" | "low";
  owaspRationale?: string;
  owaspMappedAt?: Date;
  /** How the OWASP mapping was decided: official, curated, tester or model. */
  owaspProvenance?: string;
  /** CVSS v3.0 base metrics (FIRST spec) the model rated, with the score the
   *  system computed from them. Severity always follows the score. */
  cvss?: {
    av: "N" | "A" | "L" | "P";
    ac: "L" | "H";
    pr: "N" | "L" | "H";
    ui: "N" | "R";
    s: "U" | "C";
    c: "N" | "L" | "H";
    i: "N" | "L" | "H";
    a: "N" | "L" | "H";
    score: number;
    vector: string;
  };
  /** Legacy WSTG risk-matrix factors (1–3) kept only for findings recorded
   *  before the CVSS v3.0 rating replaced the likelihood x impact matrix. */
  likelihood?: number;
  impactRating?: number;
  chatMessages: VulnerabilityChatMessageDoc[];
  /** Browser screenshots attached to this finding (filenames served via /agent/session/:id/files/:name). */
  screenshots: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc extends mongoose.Document {
  uid: mongoose.Types.ObjectId;
  sessionId: string;
  workspaceId: string;
  name: string;
  description: string;
  boxId?: mongoose.Types.ObjectId;
  createdAt: Date;
  status: "active" | "archived";
  agentState: AgentState;
  messages: AgentMessageDoc[];
  pendingConsent?: PendingConsentDoc;
  consentStats?: ConsentStatsDoc;
  turnIndex: number;
  totalTokens: number;
  tokenHistory: Array<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    timestamp: Date;
  }>;
  shells: ShellDoc[];
  subagents: SubagentDoc[];
  connectionState: ConnectionStateDoc;
  disabledAgentTools?: string[];
  /** Deferred tools loaded via the `load_tools` meta tool this session. */
  loadedTools?: string[];
  /** Engagement scope handed to the tool-approval evaluator. */
  engagementContext?: EngagementContextDoc;
  vulnerabilities?: SessionVulnerabilityDoc[];
  vulnerabilityBackfillVersion?: number;
  webAppTestPlan?: WebAppTestPlanDoc;
  /** Nessus-style run history: every launch of WSTG cases from the web UI,
   *  persisted so runs (including queued ones) survive reload and restart. */
  webAppRuns?: WebAppRunDoc[];
  /** Snapshot of the engagement state module (hosts, services, credentials,
   *  shells, implants, key discoveries, files, approaches, next steps) — how
   *  those categories survive across runs. Written only by EngagementState. */
  engagementState?: EngagementStateSnapshot;
}

const ToolCallSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    /**
     * A no-argument call stores `{}`. The setter is the storage-boundary
     * guarantee that an empty string never reaches the document: Mongoose
     * reads `""` as a missing required value, and because a turn saves the
     * entire session, one bad tool call made every later save fail with
     * "Session validation failed" — which is how a single model response
     * could kill a scan permanently. Documents written before the setter
     * existed are repaired by migration 003.
     */
    arguments: {
      type: String,
      required: true,
      set: (value: unknown) =>
        typeof value === "string" && value.trim() ? value : "{}",
    },
  },
  { _id: false },
);

const AgentMessageSchema = new Schema(
  {
    id: { type: String, required: true },
    role: {
      type: String,
      required: true,
      enum: ["system", "user", "assistant", "tool"],
    },
    content: { type: String, default: null },
    reasoning: { type: String },
    toolCalls: { type: [ToolCallSchema], default: undefined },
    toolCallId: { type: String },
    toolName: { type: String },
    files: { type: [String], default: undefined },
    timestamp: { type: Date, default: Date.now },
    turnIndex: { type: Number, default: 0 },
    isSummary: { type: Boolean, default: false },
    /**
     * Transcript channel: undefined = the main chat; "run" = produced by a
     * Nessus-style WSTG run launched from the web UI. Run messages stay in the
     * model's context but are filtered out of the chat page's history feed —
     * the run's activity is watched on the case page, not in the chat.
     */
    channel: { type: String },
  },
  { _id: false },
);

const ShellSchema = new Schema(
  {
    shellId: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true, enum: ["pty", "exec"] },
    status: { type: String, default: "active", enum: ["active", "closed"] },
    createdBy: {
      type: String,
      required: true,
      enum: ["user", "agent", "subagent"],
    },
    subagentId: { type: String },
    createdAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
  },
  { _id: false },
);

const SubagentMessageSchema = new Schema(
  {
    id: { type: String, required: true },
    role: {
      type: String,
      required: true,
      enum: ["system", "user", "assistant", "tool"],
    },
    content: { type: String, default: null },
    toolCalls: { type: [ToolCallSchema], default: undefined },
    toolCallId: { type: String },
    toolName: { type: String },
    files: { type: [String], default: undefined },
    timestamp: { type: Date, default: Date.now },
    turnIndex: { type: Number, default: 0 },
    isSummary: { type: Boolean, default: false },
  },
  { _id: false },
);

const SubagentSchema = new Schema(
  {
    subagentId: { type: String, required: true },
    parentId: { type: String, required: true },
    task: { type: String, required: true },
    status: {
      type: String,
      default: "running",
      enum: ["running", "completed", "failed", "cancelled"],
    },
    result: { type: String },
    messages: { type: [SubagentMessageSchema], default: [] },
    shells: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { _id: false },
);

const EngagementContextSchema = new Schema(
  {
    target: { type: String },
    scope: { type: String },
    credentials: { type: String },
    labels: { type: [String], default: [] },
    metadata: { type: Map, of: String, default: {} },
  },
  { _id: false },
);

const VulnerabilityChatMessageSchema = new Schema(
  {
    messageId: { type: String, required: true },
    role: { type: String, required: true, enum: ["user", "assistant"] },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const SessionTestCaseSchema = new Schema(
  {
    testId: { type: String, required: true },
    section: { type: String, default: "" },
    categoryCode: { type: String, default: "" },
    categoryName: { type: String, default: "" },
    title: { type: String, required: true },
    objective: { type: String, default: "" },
    howToTest: { type: String, default: "" },
    tools: { type: [String], default: [] },
    evidenceExpectation: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "not_started",
        "in_progress",
        "passed",
        "failed",
        "blocked",
        "skipped",
      ],
      default: "not_started",
    },
    notes: { type: String, default: "" },
    observations: { type: String, default: "" },
    linkedVulnerabilityIds: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const WebAppTestPlanSchema = new Schema(
  {
    source: { type: String, default: "OWASP WSTG v4.2" },
    version: { type: String, default: "4.2" },
    target: { type: String, default: "" },
    scope: { type: String, default: "" },
    categories: { type: [String], default: [] },
    cases: { type: [SessionTestCaseSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const WebAppRunSchema = new Schema(
  {
    runId: { type: String, required: true },
    testIds: { type: [String], default: [] },
    label: { type: String, default: "" },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "cancelled"],
      default: "queued",
    },
    triggeredBy: { type: String, default: "ui" },
    policy: {
      type: String,
      enum: ["unattended", "supervised"],
      default: "unattended",
    },
    queuedAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    durationMs: { type: Number },
    resultSummary: {
      type: {
        perCase: [{ testId: String, status: String }],
        counts: {
          passed: { type: Number, default: 0 },
          failed: { type: Number, default: 0 },
          blocked: { type: Number, default: 0 },
          other: { type: Number, default: 0 },
        },
      },
      default: undefined,
    },
    error: { type: String },
  },
  { _id: false },
);
const SessionVulnerabilitySchema = new Schema(
  {
    vulnerabilityId: { type: String, required: true },
    fingerprint: { type: String, required: true },
    title: { type: String, required: true },
    host: { type: String, default: "unknown" },
    service: { type: String },
    endpoint: { type: String },
    severity: {
      type: String,
      required: true,
      enum: ["info", "low", "medium", "high"],
      default: "info",
    },
    cwe: { type: String },
    cve: { type: String },
    description: { type: String },
    evidence: { type: String, default: "" },
    stepsToReproduce: { type: [String], default: [] },
    contextSummary: { type: String, default: "" },
    impact: { type: String },
    remediation: { type: String },
    exploited: { type: Boolean, default: false },
    source: { type: String, default: "agent" },
    wstgId: { type: String },
    wstgTitle: { type: String },
    wstgCategory: { type: String },
    owaspTop10: { type: String },
    owaspTop10Title: { type: String },
    owaspRelated: { type: [String], default: [] },
    owaspConfidence: { type: String, enum: ["high", "medium", "low"] },
    owaspRationale: { type: String },
    owaspMappedAt: { type: Date },
    owaspProvenance: { type: String },
    cvss: {
      type: {
        av: { type: String, enum: ["N", "A", "L", "P"] },
        ac: { type: String, enum: ["L", "H"] },
        pr: { type: String, enum: ["N", "L", "H"] },
        ui: { type: String, enum: ["N", "R"] },
        s: { type: String, enum: ["U", "C"] },
        c: { type: String, enum: ["N", "L", "H"] },
        i: { type: String, enum: ["N", "L", "H"] },
        a: { type: String, enum: ["N", "L", "H"] },
        score: { type: Number },
        vector: { type: String },
      },
      _id: false,
    },
    likelihood: { type: Number },
    impactRating: { type: Number },
    chatMessages: { type: [VulnerabilityChatMessageSchema], default: [] },
    /** Browser screenshots attached to this finding, served via /agent/session/:id/files/:name. */
    screenshots: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const SessionSchema = new Schema({
  uid: { type: mongoose.Types.ObjectId, required: true },
  sessionId: { type: String, required: true, unique: true },
  workspaceId: { type: String, default: "" },
  name: { type: String, required: true },
  description: { type: String, default: "" },
  boxId: { type: mongoose.Types.ObjectId },
  createdAt: { type: Date, default: Date.now },
  status: { type: String, default: "active", enum: ["active", "archived"] },
  agentState: {
    type: String,
    default: "idle",
    enum: [
      "idle",
      "running",
      "paused",
      "waiting_consent",
    ],
  },
  messages: { type: [AgentMessageSchema], default: [] },
  pendingConsent: {
    type: {
      toolCallId: { type: String, required: true },
      toolName: { type: String, required: true },
      arguments: { type: Schema.Types.Mixed, required: true },
      safetyBlock: { type: Boolean, default: false },
      approvalReason: { type: String },
      safetyReason: { type: String },
      safetyImpact: { type: String },
      safetyKind: { type: String },
      batch: {
        type: [
          {
            toolCallId: { type: String, required: true },
            toolName: { type: String, required: true },
            arguments: { type: Schema.Types.Mixed, required: true },
            safetyBlock: { type: Boolean, default: false },
            approvalReason: { type: String },
            safetyReason: { type: String },
            safetyImpact: { type: String },
            safetyKind: { type: String },
          },
        ],
        default: undefined,
      },
    },
    default: undefined,
  },
  consentStats: {
    type: {
      prompts: { type: Number, default: 0 },
      approvals: { type: Number, default: 0 },
      denials: { type: Number, default: 0 },
      safetyBlocks: { type: Number, default: 0 },
      circuitOpens: { type: Number, default: 0 },
    },
    default: undefined,
  },
  turnIndex: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  tokenHistory: {
    type: [
      {
        promptTokens: { type: Number },
        completionTokens: { type: Number },
        totalTokens: { type: Number },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  shells: { type: [ShellSchema], default: [] },
  subagents: { type: [SubagentSchema], default: [] },
  connectionState: {
    type: {
      sshConnected: { type: Boolean, default: false },
      hostConnected: { type: Boolean, default: false },
      hostKind: { type: String, enum: ["local", "ssh"] },
      lastConnectedAt: { type: Date },
      lastError: { type: String },
    },
    default: { sshConnected: false, hostConnected: false },
  },
  disabledAgentTools: {
    type: [{ type: String }],
    default: [],
  },
  // Deferred tools the agent pulled in with `load_tools`; they persist for the
  // session so the tool set stays stable across turns.
  loadedTools: {
    type: [{ type: String }],
    default: [],
  },
  engagementContext: {
    type: EngagementContextSchema,
    default: undefined,
  },
  vulnerabilities: {
    type: [SessionVulnerabilitySchema],
    default: [],
  },
  vulnerabilityBackfillVersion: { type: Number, default: 0 },
  webAppTestPlan: {
    type: WebAppTestPlanSchema,
    default: undefined,
  },
  webAppRuns: {
    type: [WebAppRunSchema],
    default: [],
  },
  // Engagement state snapshot — owned and written by the EngagementState
  // module (services/engagement-state.ts); no other code touches this field.
  engagementState: {
    type: Schema.Types.Mixed,
    default: undefined,
  },
});

SessionSchema.index({ workspaceId: 1, status: 1 });

export { AgentMessageSchema };
export default mongoose.model<SessionDoc>("Session", SessionSchema);
