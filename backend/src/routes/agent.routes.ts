import express from "express";
import { verifySess } from "../middlewares/VerifySession.middleware";
import {
  createSession,
  sendMessage,
  pauseAgent,
  resumeAgent,
  respondToConsent,
  getHistory,
  getSessionInfo,
  deleteSession,
  getUserSessions,
  clearContext,
  handleSlashCommand,
  getSlashCommands,
  getSessionAgentToolsConfig,
  updateSessionAgentToolsConfig,
  installCapability,
  getSessionFile,
} from "../controllers/agent.controller";
import {
  chatAboutVulnerability,
  getVulnerabilities,
  getVulnerability,
} from "../controllers/vulnerability.controller";
import {
  deleteTestRun,
  generateTestPlan,
  getOwaspCoverage,
  getReport,
  getTestPlan,
  getTestRunDetail,
  getTestRuns,
  launchTestRun,
  openReportWord,
  downloadReportDocxFile,
  exportReportPdf,
  mapVulnerability,
  remapAllVulnerabilities,
  removeTestCase,
  removeTestCases,
  stopTestRun,
  updateTestCaseStatus,
} from "../controllers/web-security.controller";

const router = express.Router();

// Signed LLM pass-through for the Magnitude browser agent — mounted without
// verifySess because the in-container agent authenticates via HMAC'd URL.
import { llmProxyRouter } from "../utils/llmProxy";
router.use("/llm-proxy", llmProxyRouter);

router.post("/create-session", [verifySess], createSession);
router.post("/sessions", [verifySess], getUserSessions);
router.get("/session/:sessionId", [verifySess], getSessionInfo);
router.get("/session/:sessionId/history", [verifySess], getHistory);
router.get("/session/:sessionId/agent-tools-config", [verifySess], getSessionAgentToolsConfig);
router.post("/session/:sessionId/agent-tools-config", [verifySess], updateSessionAgentToolsConfig);
router.get("/session/:sessionId/vulnerabilities", [verifySess], getVulnerabilities);
router.get("/session/:sessionId/vulnerabilities/:vulnerabilityId", [verifySess], getVulnerability);
router.post("/session/:sessionId/vulnerabilities/map-all", [verifySess], remapAllVulnerabilities);
router.post("/session/:sessionId/vulnerabilities/:vulnerabilityId/map", [verifySess], mapVulnerability);
router.post("/session/:sessionId/vulnerabilities/:vulnerabilityId/chat", [verifySess], chatAboutVulnerability);

router.get("/session/:sessionId/test-plan", [verifySess], getTestPlan);
router.post("/session/:sessionId/test-plan", [verifySess], generateTestPlan);
router.patch("/session/:sessionId/test-plan/cases/:testId", [verifySess], updateTestCaseStatus);
router.delete("/session/:sessionId/test-plan/cases/:testId", [verifySess], removeTestCase);
router.post("/session/:sessionId/test-plan/cases/remove", [verifySess], removeTestCases);
router.post("/session/:sessionId/test-plan/run", [verifySess], launchTestRun);
router.get("/session/:sessionId/test-plan/runs", [verifySess], getTestRuns);
router.get("/session/:sessionId/test-plan/runs/:runId", [verifySess], getTestRunDetail);
router.post("/session/:sessionId/test-plan/runs/:runId/stop", [verifySess], stopTestRun);
router.delete("/session/:sessionId/test-plan/runs/:runId", [verifySess], deleteTestRun);
router.get("/session/:sessionId/report", [verifySess], getReport);
router.post("/session/:sessionId/report/word", [verifySess], openReportWord);
router.get("/session/:sessionId/report/docx", [verifySess], downloadReportDocxFile);
router.get("/session/:sessionId/report/pdf", [verifySess], exportReportPdf);
router.get("/session/:sessionId/owasp-top10", [verifySess], getOwaspCoverage);
router.get("/session/:sessionId/files/:filename", [verifySess], getSessionFile);
router.post("/delete-session", [verifySess], deleteSession);

router.post("/message", [verifySess], sendMessage);
router.post("/pause", [verifySess], pauseAgent);
router.post("/resume", [verifySess], resumeAgent);
router.post("/consent", [verifySess], respondToConsent);
router.post("/clear-context", [verifySess], clearContext);
router.post("/slash-command", [verifySess], handleSlashCommand);
router.get("/slash-commands", [verifySess], getSlashCommands);
router.post("/install-capability", [verifySess], installCapability);

export { router as agentRoutes };
