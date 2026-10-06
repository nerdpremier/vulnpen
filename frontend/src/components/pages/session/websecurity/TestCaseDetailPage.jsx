"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { App, Button, Dropdown, Form, Input, Modal, Select, Spin } from "antd";
import {
  ArrowLeftOutlined,
  CaretDownOutlined,
  EditOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import {
  getTestPlan,
  getTestRuns,
  runTestCases,
  updateTestCase,
} from "@/services/websecurity.service";
import { getVulnerabilities } from "@/services/agent.service";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { apiErrorMessage } from "@/utils/apiError";
import vStyles from "@/styles/pages/Vulnerabilities.module.scss";
import styles from "@/styles/pages/TestPlan.module.scss";
import { STATUS_OPTIONS } from "@/utils/testPlan.mjs";
import { activeRunForCase } from "@/utils/runs.mjs";
import RunHistorySection from "./RunHistorySection";

/** Colour the status pill (box tint) and its text. Detail page only. */
const PILL_TONE = {
  not_started: styles.pillIdle,
  in_progress: styles.pillActive,
  passed: styles.pillPassed,
  failed: styles.pillFailed,
  blocked: styles.pillBlocked,
  skipped: styles.pillIdle,
};

/** Colour accents per body section, echoing the vuln page's severity palette. */
const SECTION_TONES = {
  Objective: "purple",
  Method: "blue",
  "Expected evidence": "green",
  Tools: "orange",
  "Observations recorded": "yellow",
  Notes: "gray",
  Findings: "red",
};

/** Collapse tool names for display: every Burp-suite helper is just "burp". */
const toolLabels = (tools) => {
  const seen = new Set();
  const labels = [];
  for (const tool of tools ?? []) {
    const label = tool.toLowerCase().includes("burp") ? "burp" : tool;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push([label, tool]);
    }
  }
  return labels;
};

/** A divider-separated report section inside the single document card. */
function DocSection({ label, children }) {
  const tone = SECTION_TONES[label] ?? "gray";
  return (
    <section className={`${styles.caseDocSection} ${styles[`tone_${tone}`]}`}>
      <h2 className={styles.caseDocLabel}>{label}</h2>
      <div className={styles.caseDocBody}>{children}</div>
    </section>
  );
}

export default function TestCaseDetailPage({ sessionId, testId }) {
  const router = useRouter();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState(false);
  // Which half of the page is showing: the case document, or the Nessus-style
  // run monitor. Launching a run flips to the monitor automatically.
  const [view, setView] = useState("details");

  // Runs share the query key with the history section; while one of them owns
  // this case, the plan polls so the status pill and coverage keep up.
  const runsQuery = useQuery(["test-runs", sessionId], () => getTestRuns(sessionId));
  const runs = runsQuery.data?.runs ?? [];
  const runActive = runs.some(
    (run) => run.status === "queued" || run.status === "running",
  );

  const planQuery = useQuery(["test-plan", sessionId], () => getTestPlan(sessionId), {
    refetchInterval: runActive ? 4000 : false,
  });
  const plan = planQuery.data?.plan ?? null;

  const testCase = useMemo(() => {
    const wanted = decodeURIComponent(testId).trim().toUpperCase();
    return (
      (plan?.cases ?? []).find((one) => one.testId.toUpperCase() === wanted) ?? null
    );
  }, [plan, testId]);

  const categoryCases = useMemo(() => {
    if (!plan || !testCase) return [];
    return (plan.cases ?? []).filter(
      (one) => one.categoryCode === testCase.categoryCode,
    );
  }, [plan, testCase]);

  const remainingInCategory = categoryCases.filter(
    (one) => one.status === "not_started" || one.status === "in_progress",
  );

  const vulnerabilitiesQuery = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
  );
  const caseFindings = useMemo(() => {
    const linked = new Set(testCase?.linkedVulnerabilityIds ?? []);
    return (vulnerabilitiesQuery.data?.vulnerabilities ?? []).filter((vuln) =>
      linked.has(vuln.vulnerabilityId),
    );
  }, [vulnerabilitiesQuery.data, testCase]);

  const invalidate = () => queryClient.invalidateQueries(["test-plan", sessionId]);

  const launchMutation = useMutation(runTestCases, {
    onSuccess: (data) => {
      message.success(
        data.queued
          ? `Run queued — position ${data.position}`
          : "Run started — follow it in the run monitor",
      );
      queryClient.invalidateQueries(["test-runs", sessionId]);
      useAgentStreamStore.getState().markHistoryStale?.(sessionId);
      setView("runs");
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not start the run")),
  });

  const statusMutation = useMutation(updateTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testCase?.testId} -> ${data.testCase?.status}`);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not save the result")),
  });

  const updateCaseMutation = useMutation(updateTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testCase?.testId} updated`);
      setEditing(false);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not update the case")),
  });

  const openEdit = () => {
    setEditing(true);
    editForm.setFieldsValue({
      title: testCase.title,
      objective: testCase.objective,
      howToTest: testCase.howToTest,
      evidenceExpectation: testCase.evidenceExpectation,
      tools: (testCase.tools ?? []).join(", "),
      observations: testCase.observations,
      notes: testCase.notes,
    });
  };

  const handleEditCase = (values) => {
    updateCaseMutation.mutate({
      sessionId,
      testId: testCase.testId,
      title: values.title?.trim(),
      objective: values.objective?.trim() || undefined,
      howToTest: values.howToTest?.trim() || undefined,
      evidenceExpectation: values.evidenceExpectation?.trim() || undefined,
      tools:
        typeof values.tools === "string"
          ? values.tools
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean)
          : undefined,
      observations: values.observations?.trim() || undefined,
      notes: values.notes?.trim() || undefined,
    });
  };

  if (planQuery.isLoading) {
    return (
      <div className={vStyles.fullState}>
        <Spin />
      </div>
    );
  }

  if (planQuery.isError || !testCase) {
    return (
      <div className={vStyles.detailPage}>
        <header className={vStyles.detailHeader}>
          <button
            className={vStyles.backButton}
            onClick={() => router.push(`/session/${sessionId}/test-plan`)}
          >
            <ArrowLeftOutlined /> All test cases
          </button>
        </header>
        <div className={vStyles.findingDocument}>
          {planQuery.isError
            ? "Could not load the test plan."
            : `Test case ${decodeURIComponent(testId)} is not in this plan.`}
        </div>
      </div>
    );
  }

  const activeRun = activeRunForCase(runs, testCase.testId);

  const runMenuItems = [
    {
      key: "category",
      label: `Run whole category — ${testCase.categoryCode} (${categoryCases.length} cases)`,
      disabled: launchMutation.isLoading,
      onClick: () =>
        launchMutation.mutate({
          sessionId,
          testIds: categoryCases.map((one) => one.testId),
        }),
    },
    {
      key: "remaining",
      label: `Run remaining in category (${remainingInCategory.length} not executed)`,
      disabled: launchMutation.isLoading || remainingInCategory.length === 0,
      onClick: () =>
        launchMutation.mutate({
          sessionId,
          testIds: remainingInCategory.map((one) => one.testId),
        }),
    },
  ];

  return (
    <div className={`${vStyles.detailPage} ${styles.casePage}`}>
      <header className={styles.caseHero}>
        <div className={styles.caseHeroTop}>
          <button
            className={vStyles.backButton}
            onClick={() => router.push(`/session/${sessionId}/test-plan`)}
          >
            <ArrowLeftOutlined /> All test cases
          </button>
          <div className={styles.caseHeaderActions}>
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={launchMutation.isLoading}
              onClick={() => launchMutation.mutate({ sessionId, testIds: [testCase.testId] })}
            >
              Run
            </Button>
            <Dropdown menu={{ items: runMenuItems }} trigger={["click"]}>
              <Button icon={<CaretDownOutlined />} aria-label="More run options" />
            </Dropdown>
          </div>
        </div>

        <div className={styles.caseHeroBody}>
          <div className={styles.caseBadges}>
            <span className={styles.caseIdPill}>{testCase.testId}</span>
            {testCase.categoryCode && (
              <span className={styles.caseCategoryChip}>{testCase.categoryCode}</span>
            )}
            {activeRun && (
              <span className={styles.activeRunBadge}>
                {activeRun.status === "queued"
                  ? `queued · #${activeRun.position ?? 1}`
                  : "agent running"}
              </span>
            )}
          </div>
          <h1 className={styles.caseHeroTitle}>{testCase.title}</h1>
          {testCase.objective && (
            <p className={styles.caseLead}>{testCase.objective}</p>
          )}

          <div className={styles.caseMetaRow}>
            <div className={styles.caseMetaTile}>
              <span className={styles.caseMetaLabel}>Status</span>
              <Select
                className={`${styles.scoreSelect} ${PILL_TONE[testCase.status] ?? ""}`}
                classNames={{ popup: { root: styles.statusDropdown } }}
                value={testCase.status}
                options={STATUS_OPTIONS}
                loading={
                  statusMutation.isLoading &&
                  statusMutation.variables?.testId === testCase.testId
                }
                onChange={(value) =>
                  statusMutation.mutate({
                    sessionId,
                    testId: testCase.testId,
                    status: value,
                  })
                }
              />
            </div>
            <div className={styles.caseMetaTile}>
              <span className={styles.caseMetaLabel}>Findings</span>
              {caseFindings.length > 0 ? (
                <Link
                  href={
                    caseFindings.length === 1
                      ? `/session/${sessionId}/vulnerabilities/${caseFindings[0].vulnerabilityId}`
                      : `/session/${sessionId}/vulnerabilities`
                  }
                  className={styles.caseFindingsValue}
                  title="Open the finding recorded for this case"
                >
                  {caseFindings.length} finding{caseFindings.length === 1 ? "" : "s"}
                </Link>
              ) : (
                <span className={styles.caseFindingsValue}>none</span>
              )}
            </div>
            {(testCase.tools ?? []).length > 0 && (
              <div className={`${styles.caseMetaTile} ${styles.caseMetaTileWide}`}>
                <span className={styles.caseMetaLabel}>Tools</span>
                <div className={styles.caseToolPills}>
                  {toolLabels(testCase.tools).map(([label, tool]) => (
                    <span key={tool} className={styles.caseToolPill} title={tool}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={styles.viewTabs}>
          <button
            type="button"
            className={`${styles.viewTab} ${view === "details" ? styles.viewTabActive : ""}`}
            onClick={() => setView("details")}
          >
            Details
          </button>
          <button
            type="button"
            className={`${styles.viewTab} ${view === "runs" ? styles.viewTabActive : ""}`}
            onClick={() => setView("runs")}
          >
            Run monitor
            {activeRun && <span className={styles.viewTabDot} aria-label="a run is active" />}
          </button>
        </div>
      </header>

      {view === "runs" ? (
        <RunHistorySection
          sessionId={sessionId}
          testCase={testCase}
          planCases={plan?.cases ?? []}
        />
      ) : (
        <div className={styles.caseDoc}>
          {!testCase.objective && (
            <DocSection label="Objective">
              {testCase.objective || "Not described."}
            </DocSection>
          )}
          <DocSection label="Method">
            {testCase.howToTest || "Not described."}
          </DocSection>
          <DocSection label="Expected evidence">
            {testCase.evidenceExpectation || "Not described."}
          </DocSection>
          <DocSection label="Observations recorded">
            {testCase.observations || "Nothing recorded yet."}
          </DocSection>
          {testCase.notes && (
            <DocSection label="Notes">{testCase.notes}</DocSection>
          )}
          <DocSection label="Findings">
            {caseFindings.length > 0 ? (
              <ul className={styles.findingList}>
                {caseFindings.map((vuln) => (
                  <li key={vuln.vulnerabilityId} className={styles.findingItem}>
                    <span
                      className={`${vStyles.severity} ${
                        vStyles[vuln.severity || "info"]
                      }`}
                    >
                      {vuln.severity || "info"}
                    </span>
                    <Link
                      href={`/session/${sessionId}/vulnerabilities/${vuln.vulnerabilityId}`}
                      className={styles.findingLink}
                    >
                      {vuln.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className={styles.caseDocMuted}>
                No vulnerability has been linked to this case.
              </span>
            )}
          </DocSection>
        </div>
      )}

      <Modal
        open={editing}
        onCancel={() => setEditing(false)}
        title={`Edit test case ${testCase.testId}`}
        confirmLoading={updateCaseMutation.isLoading}
        okText="Save changes"
        onOk={() => editForm.submit()}
      >
        <Form
          form={editForm}
          layout="vertical"
          className={styles.darkControls}
          onFinish={handleEditCase}
        >
          <Form.Item
            label="Title"
            name="title"
            rules={[{ required: true, message: "Title cannot be empty" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="Objective" name="objective">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="How to test" name="howToTest">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item label="Expected evidence" name="evidenceExpectation">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            label="Tools"
            name="tools"
            extra="Comma separated — tools containing “burp” display as a single burp pill"
          >
            <Input placeholder="curl, nmap, burp" />
          </Form.Item>
          <Form.Item label="Observations recorded" name="observations">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
