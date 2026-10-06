import { apiClient } from "@/utils/axios.config";

// --- OWASP WSTG v4.2 test plan ---------------------------------------

export const getTestPlan = async (sessionId) => {
  const res = await apiClient.get(`/agent/session/${sessionId}/test-plan`);
  return res.data;
};

/** Build or rebuild the plan. Cases already in it keep the result they carry. */
export const generateTestPlan = async ({ sessionId, ...body }) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/test-plan`, {
    ...body,
    action: "generate",
  });
  return res.data;
};


/** Add WSTG catalogue cases to a plan that already exists, by test id. */
export const addCatalogueCases = async ({ sessionId, testIds }) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/test-plan`, {
    action: "add_case",
    testIds,
  });
  return res.data;
};



export const updateTestCase = async ({ sessionId, testId, ...body }) => {
  const res = await apiClient.patch(
    `/agent/session/${sessionId}/test-plan/cases/${testId}`,
    body,
  );
  return res.data;
};

export const removeTestCase = async ({ sessionId, testId }) => {
  const res = await apiClient.delete(
    `/agent/session/${sessionId}/test-plan/cases/${testId}`,
  );
  return res.data;
};

/** Remove several cases at once: an explicit testIds list, or every case in a category. */
export const removeTestCases = async ({ sessionId, ...body }) => {
  const res = await apiClient.post(
    `/agent/session/${sessionId}/test-plan/cases/remove`,
    body,
  );
  return res.data;
};

// --- OWASP Top 10:2025 ----------------------------------------------

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

// --- Report (LibreOffice / Collabora) --------------------------------

export const getWordEditorUrl = async (sessionId) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/report/word`);
  return res.data;
};
// --- Nessus-style runs (launch WSTG cases from the web UI) ------------

/** Queue one or more cases for the agent to execute, one run at a time. */
export const runTestCases = async ({ sessionId, testIds }) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/test-plan/run`, {
    testIds,
  });
  return res.data;
};

export const getTestRuns = async (sessionId) => {
  const res = await apiClient.get(`/agent/session/${sessionId}/test-plan/runs`);
  return res.data;
};

/** One run plus its activity feed — polled while the run is live. */
export const getTestRunDetail = async (sessionId, runId) => {
  const res = await apiClient.get(
    `/agent/session/${sessionId}/test-plan/runs/${runId}`,
  );
  return res.data;
};

export const stopTestRun = async (sessionId, runId) => {
  const res = await apiClient.post(
    `/agent/session/${sessionId}/test-plan/runs/${runId}/stop`,
  );
  return res.data;
};

export const cancelTestRun = async (sessionId, runId) => {
  const res = await apiClient.delete(
    `/agent/session/${sessionId}/test-plan/runs/${runId}`,
  );
  return res.data;
};
