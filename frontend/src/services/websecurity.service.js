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

/**
 * Open the report in the Word editor. `rebuild` discards hand edits made in
 * Word and regenerates the document from the engagement's current results —
 * without it, a document that has been saved in Word never picks up later
 * scans or findings.
 */
export const getWordEditorUrl = async (sessionId, { rebuild = false } = {}) => {
  const res = await apiClient.post(
    `/agent/session/${sessionId}/report/word`,
    { rebuild },
  );
  return res.data;
};

/** Read the file name the API chose for an attachment response. */
const attachmentName = (headers, fallback) => {
  const disposition = headers?.["content-disposition"] ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^"';]+)"?/i.exec(disposition);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
};

/** Fetch a report export as `{ blob, fileName }` so the caller can save it. */
const fetchReportFile = async (url, fallbackName) => {
  const res = await apiClient.get(url, { responseType: "blob" });
  return {
    blob: res.data,
    fileName: attachmentName(res.headers, fallbackName),
  };
};

export const downloadReportDocx = (sessionId, { rebuild = false } = {}) =>
  fetchReportFile(
    `/agent/session/${sessionId}/report/docx${rebuild ? "?rebuild=1" : ""}`,
    "report.docx",
  );

export const downloadReportPdf = (sessionId, { rebuild = false } = {}) =>
  fetchReportFile(
    `/agent/session/${sessionId}/report/pdf${rebuild ? "?rebuild=1" : ""}`,
    "report.pdf",
  );

export const downloadReportMarkdown = (sessionId) =>
  fetchReportFile(`/agent/session/${sessionId}/report?download=1`, "report.md");

// --- Scans (Nessus-style execution of WSTG cases) ---------------------

/**
 * Launch a scan over a set of WSTG cases. `policy` decides how much the scan
 * may assume: "unattended" lets the Approve-for-me reviewer clear approval
 * boundaries so the scan finishes on its own, "supervised" keeps the user's
 * own tool-execution mode and may park the scan for a human.
 */
export const launchScan = async ({ sessionId, testIds, label, policy }) => {
  const res = await apiClient.post(`/agent/session/${sessionId}/test-plan/run`, {
    testIds,
    label,
    policy,
  });
  return res.data;
};

/** The session's scan history, newest first; `testId` narrows it to one case. */
export const getScans = async (sessionId, { testId } = {}) => {
  const res = await apiClient.get(`/agent/session/${sessionId}/test-plan/runs`, {
    params: testId ? { testId } : undefined,
  });
  return res.data;
};

/** One scan with its results and activity feed — polled while it is live. */
export const getScanDetail = async (sessionId, runId) => {
  const res = await apiClient.get(
    `/agent/session/${sessionId}/test-plan/runs/${runId}`,
  );
  return res.data;
};

export const stopScan = async (sessionId, runId) => {
  const res = await apiClient.post(
    `/agent/session/${sessionId}/test-plan/runs/${runId}/stop`,
  );
  return res.data;
};

/** Remove a scan from the history (a queued one is cancelled, not lost). */
export const deleteScan = async (sessionId, runId) => {
  const res = await apiClient.delete(
    `/agent/session/${sessionId}/test-plan/runs/${runId}`,
  );
  return res.data;
};
