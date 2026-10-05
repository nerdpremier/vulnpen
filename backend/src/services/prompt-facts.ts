import SessionsModel, {
  AgentMessageDoc,
  SessionVulnerabilityDoc,
} from "../models/Sessions/Sessions.model";
import UserModel from "../models/User/User.model";
import { computeOwaspCoverage } from "../knowledge";
import {
  buildSystemPrompt,
  buildVolatileWebAppPrompt,
  AgentPromptConfig,
  BoxEnvInfo,
} from "../utils/assistant/prompts";
import { systemNoteMessage } from "./session-transcript";
import { getUnconfiguredToolNames } from "../utils/toolAvailability";

// ─── Prompt facts ──────────────────────────────────────────────────────
// Everything the prompt renders FROM the session document: the declared
// engagement boundary, the WSTG plan + OWASP risk posture, the user's
// capability lists, and the run-date facts. The agent loop asks for a
// system message or the volatile web-app block; how those facts are
// loaded and shaped stays here. Every call re-reads the document on
// purpose — tools mutate the plan and findings mid-run, so a cached
// snapshot would go stale.

/** The session-sourced half of the prompt config. */
export interface SessionPromptFacts {
  engagement: { target: string; scope: string };
  webAppSecurity: NonNullable<AgentPromptConfig["webAppSecurity"]>;
}

/** The lean session shape the projection reads. */
interface PromptFactsSource {
  engagementContext?: { target?: string; scope?: string } | null;
  webAppTestPlan?: unknown;
  vulnerabilities?: unknown[];
}

/**
 * The projection from a session document to prompt facts. Pure, so the
 * engagement fallbacks and the coverage shaping are testable without
 * Mongo; the async wrappers below own the fetching.
 */
export function promptFactsFromSession(
  session: PromptFactsSource | null,
): SessionPromptFacts {
  const storedVulnerabilities = (session?.vulnerabilities ?? []) as SessionVulnerabilityDoc[];
  const owaspCoverage = computeOwaspCoverage(storedVulnerabilities);
  return {
    engagement: {
      target: session?.engagementContext?.target ?? "",
      scope: session?.engagementContext?.scope ?? "",
    },
    webAppSecurity: {
      testPlan: (session?.webAppTestPlan as any) ?? null,
      findingCount: owaspCoverage.total,
      unmappedFindingCount: owaspCoverage.unmapped,
      owaspBreakdown: owaspCoverage.byOwasp.filter((row) => row.findings > 0),
    },
  };
}

async function loadSessionPromptFacts(sessionId: string): Promise<SessionPromptFacts> {
  const session = await SessionsModel.findOne({ sessionId })
    .select("workspaceId engagementContext webAppTestPlan vulnerabilities")
    .lean();
  return promptFactsFromSession(session as PromptFactsSource | null);
}

async function buildAgentPromptConfig(
  sessionId: string,
  userId: string,
  envInfo?: BoxEnvInfo,
): Promise<AgentPromptConfig> {
  const user = await UserModel.findById(userId);
  const now = new Date();
  const { engagement, webAppSecurity } = await loadSessionPromptFacts(sessionId);
  return {
    sessionId,
    installedCapabilities: user?.configs?.installedCapabilities ?? [],
    selectedCapabilities: user?.configs?.capabilities ?? [],
    currentDate: now.toISOString().split("T")[0],
    currentDay: now.toLocaleDateString("en-US", { weekday: "long" }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    envInfo,
    // Same readiness seam the schema filter uses, so the prompt can never
    // advertise a tool the model is not actually offered.
    unconfiguredToolNames: await getUnconfiguredToolNames(),
    engagement,
    webAppSecurity,
  };
}

/**
 * Re-render the volatile web-app part (WSTG plan + OWASP risk posture) from
 * the session document. Called EVERY tool-loop iteration: update_case and
 * add_vulnerability persist through session-plan-store and the vulnerability
 * tools, so the session snapshot the loop holds in memory goes stale the
 * moment a tool mutates the plan — rendering from the document keeps the
 * model's plan view in step with what the tools report.
 */
export async function buildVolatileWebAppForSession(sessionId: string): Promise<string> {
  const { engagement, webAppSecurity } = await loadSessionPromptFacts(sessionId);
  return buildVolatileWebAppPrompt({ sessionId, engagement, webAppSecurity });
}

/**
 * The turn's system message: static prompt (capabilities, engagement
 * boundary, date facts) plus the box env block. Rebuilt fresh per turn so
 * Settings changes reach the model on the next run.
 */
export async function buildSystemMessage(
  sessionId: string,
  userId: string,
  envInfo?: BoxEnvInfo,
): Promise<AgentMessageDoc> {
  const promptConfig = await buildAgentPromptConfig(sessionId, userId, envInfo);
  return systemNoteMessage(`sys_${sessionId}`, buildSystemPrompt(promptConfig), 0);
}
