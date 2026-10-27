import mongoose from "mongoose";
import {
  DEFAULT_MAX_AGENT_ITERATIONS,
  MAX_MAX_AGENT_ITERATIONS,
  MIN_MAX_AGENT_ITERATIONS,
} from "../../utils/agentConfig";
const Schema = mongoose.Schema;

export interface ModelPresetDoc {
  id?: string;
  label: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  reasoningMode?: string;
  isOrchestrator?: boolean;
}

/**
 * How the agent acts. Three modes, mirroring Claude's permission menu:
 *   - `auto` ("Auto"): tools run; an action that crosses the deterministic
 *     approval boundary asks the operator. A destructive action against the
 *     target stops for the operator rather than being auto-approved.
 *   - `requires_consent` ("Manual"): every tool action asks the operator.
 *   - `auto_approve` ("Bypass permissions"): fully autonomous. Every action
 *     runs without asking — the deterministic boundary is computed and logged,
 *     but it never becomes a prompt. The operator chose this mode to let the
 *     agent run the whole engagement on its own.
 *
 * Auto and Manual are the human-facing modes: a destructive action against the
 * engagement target stops for the operator in both.
 */
export type ToolExecutionMode = "auto" | "auto_approve" | "requires_consent";

export function resolveToolExecutionMode(configs?: {
  toolExecutionMode?: ToolExecutionMode;
  requireConsentForAllTools?: boolean;
}): ToolExecutionMode {
  return configs?.toolExecutionMode ??
    (configs?.requireConsentForAllTools ? "requires_consent" : "auto");
}

export interface UserDoc extends mongoose.Document {
  installationId?: string;
  email: string;
  name: string;
  password: string;
  failedLoginCount: number;
  lockedUntil?: Date | null;
  profilePicture: string;
  openvpnFile: string;
  firstLogin?: boolean;
  ipLocation: {
    ip: string;
    range: [number, number];
    country: string;
    region: string;
    eu: string;
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  };
  ip: string;
  configs: {
    tools: string[];
    capabilities: string[];
    installedCapabilities: string[];
    requireConsentForAllTools?: boolean;
    toolExecutionMode?: ToolExecutionMode;
    disableSafetyProtections?: boolean;
    disabledAgentTools?: string[];
    maxAgentIterations?: number;
    models?: ModelPresetDoc[];
  };
  referredBy: mongoose.Types.ObjectId;
  workingIndustry: string;
  workingExperience: string;
  referralSource: string;
}

const UserSchema = new Schema({
  installationId: { type: String, unique: true, sparse: true },
  email: {
    type: String,
    unique: true,
    required: true,
    match: /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,20})+$/,
  },
  name: { type: String, required: true },
  password: { type: String, required: true },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  profilePicture: { type: String },
  openvpnFile: { type: String },
  firstLogin: { type: Boolean, default: true },
  ipLocation: {
    ip: { type: String },
    range: [Number, Number],
    country: { type: String },
    region: { type: String },
    eu: { type: String },
    timezone: { type: String },
    city: { type: String },
    ll: [Number, Number],
    metro: Number,
    area: Number,
  },
  ip: { type: String },
  configs: {
    tools: {
      type: [
        {
          type: String,
        },
      ],
      default: ["nmap", "feroxbuster", "subfinder", "hydra", "sqlmap"],
    },
    capabilities: {
      type: [{ type: String }],
      default: [
        "python3",
        "gcc",
        "make",
        "git",
        "curl",
        "nc",
        "socat",
        "ssh",
        "file",
        "strings",
        "xxd",
        "openssl",
        "jq",
        "tmux",
        "requests",
        "pyyaml",
        "beautifulsoup4",
        "Pillow",
        "python-magic",
        "chepy",
        "nmap",
        "feroxbuster",
        "subfinder",
        "hydra",
        "sqlmap",
      ],
    },
    installedCapabilities: {
      type: [{ type: String }],
      default: [],
    },
    requireConsentForAllTools: {
      type: Boolean,
    },
    toolExecutionMode: {
      type: String,
      // Keep in step with ToolExecutionMode. A stored value the enum does not
      // accept would make every later save fail, including the save that
      // changes the setting back.
      enum: ["auto", "auto_approve", "requires_consent"],
    },
    disableSafetyProtections: {
      type: Boolean,
      default: false,
    },
    disabledAgentTools: {
      type: [{ type: String }],
      default: [],
    },
    // The bounds and the default come from agentConfig, so the schema cannot
    // disagree with what the API validates and what the loop clamps to: max 200
    // here vs 500 advertised there made a save of 201-500 pass the controller
    // and then fail silently at the schema.
    maxAgentIterations: {
      type: Number,
      min: MIN_MAX_AGENT_ITERATIONS,
      max: MAX_MAX_AGENT_ITERATIONS,
      default: DEFAULT_MAX_AGENT_ITERATIONS,
    },
    models: {
      type: [
        {
          id: { type: String },
          label: { type: String, required: true },
          provider: { type: String, required: true },
          model: { type: String, required: true },
          apiKey: { type: String },
          baseURL: { type: String },
          reasoningMode: {
            type: String,
            enum: ["off", "low", "medium", "high", "xhigh", "max"],
            default: "off",
          },
          isOrchestrator: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
  },
  referredBy: { type: mongoose.Schema.Types.ObjectId },
  workingIndustry: { type: String },
  workingExperience: { type: String },
  referralSource: { type: String },
});

export default mongoose.model<UserDoc>("User", UserSchema);
