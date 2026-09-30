import { apiClient } from "@/utils/axios.config";

// ─── OWASP WSTG v4.2 test plan ───────────────────────────────────────

export const getTestPlan = async (sessionId) => {
  const res = await apiClient.get(`/agent/session/${sessionId}/test-plan`);
  return res.data;
};

export const generateTestPlan = async ({ sessionId, ...body }) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/test-plan`, body);
  return res.data;
};

export const addTestCase = async ({ sessionId, ...body }) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/test-plan`, body);
  return res.data;
};

export const updateTestCase = async ({ sessionId, testId, ...body }) => {
  const res = await apiClient.patch(
    `/agent/session/${sessionId}/test-plan/cases/${testId}`,
    body,
  );
  return res.data;
};

// ─── OWASP Top 10:2025 ──────────────────────────────────────────────

export const getOwaspCoverage = async (sessionId) => {
  const res = await apiClient.get(`/agent/session/${sessionId}/owasp-top10`);
  return res.data;
};

export const mapVulnerability = async ({ sessionId, vulnerabilityId, ...body }) => {
  const res = await apiClient.post(
    `/agent/session/${sessionId}/vulnerabilities/${vulnerabilityId}/map`,
    body,
  );
  return res.data;
};

export const remapAllVulnerabilities = async (sessionId) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/vulnerabilities/map-all`);
  return res.data;
};

// ─── Draft report ───────────────────────────────────────────────────

export const getReportDraft = async (sessionId) => {
  const res = await apiClient.get(`/agent/session/${sessionId}/report`);
  return res.data;
};

export const downloadReportDraftUrl = (sessionId) =>
  `/agent/session/${sessionId}/report?download=1`;