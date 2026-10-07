"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { App, Button, Dropdown, Form, Input, Modal, Select } from "antd";
import {
  ArrowLeftOutlined,
  CaretDownOutlined,
  EditOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import {
  getTestPlan,
  getScans,
  launchScan,
  updateTestCase,
} from "@/services/websecurity.service";
import { getVulnerabilities } from "@/services/agent.service";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { apiErrorMessage } from "@/utils/apiError";
import vStyles from "@/styles/pages/Vulnerabilities.module.scss";
import styles from "@/styles/pages/TestPlan.module.scss";
import { STATUS_OPTIONS, summarise } from "@/utils/testPlan.mjs";
import { activeScanForCase, isScanLive } from "@/utils/scans.mjs";
import { CaseMatrix, PageShell, PageState } from "@/components/common/ui";
import CaseScanList, { caseScansQueryKey } from "../scans/CaseScanList";

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
  // The URL's test id, in the plan's own form — one place decodes it, so the
  // scans query and the plan lookup can never disagree about which case this is.
  const caseId = useMemo(
    () => decodeURIComponent(testId).trim().toUpperCase(),
    [testId],
  );

  // This case's own scans, newest first. The list section below shares this
  // query key, so both read one poll; while a scan owns the case, the plan
  // polls too so the status pill and its observations keep up.
  const scansQuery = useQuery(
    caseScansQueryKey(sessionId, caseId),
    () => getScans(sessionId, { testId: caseId }),
    {
      enabled: !!sessionId && !!caseId,
      refetchInterval: (data) => ((data?.runs ?? []).some(isScanLive) ? 2000 : false),
    },
  );
  const scans = scansQuery.data?.runs ?? [];
  const scanLive = scans.some(isScanLive);

  const planQuery = useQuery(["test-plan", sessionId], () => getTestPlan(sessionId), {
    refetchInterval: scanLive ? 4000 : false,
  });
  const plan = planQuery.data?.plan ?? null;

  const testCase = useMemo(
    () => (plan?.cases ?? []).find((one) => one.testId.toUpperCase() === caseId) ?? null,
    [plan, caseId],
  );

  const categoryCases = useMemo(() => {
    if (!plan || !testCase) return [];
    return (plan.cases ?? []).filter(
      (one) => one.categoryCode === testCase.categoryCode,
    );
  }, [plan, testCase]);

  const remainingInCategory = categoryCases.filter(
    (one) => one.status === "not_started" || one.status === "in_progress",
  );

  // The chapter's own name and outcome, for the strip under the case header.
  // Both come from the plan query this page already runs.
  const chapter = useMemo(
    () =>
      (planQuery.data?.catalog?.categories ?? []).find(
        (category) => category.code === testCase?.categoryCode,
      ) ?? null,
    [planQuery.data, testCase],
  );
  const chapterCounts = useMemo(() => summarise(categoryCases), [categoryCases]);

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

  const invalidate = () => {
    queryClient.invalidateQueries(["test-plan", sessionId]);
    queryClient.invalidateQueries(["case-scans", sessionId]);
  };

  // Launching never opens a chat: the case page hands the work to a scan and
  // follows it to the scan's own page, where the results land.
  const launchMutation = useMutation(launchScan, {
    onSuccess: (data) => {
      message.success(
        data.queued
          ? `Scan queued — position ${data.position}`
          : "Scan launched — its results land on the scan page",
      );
      queryClient.invalidateQueries(["case-scans", sessionId]);
      // The sidebar and the scans page read this key, and the sidebar only
      // starts polling once it knows a scan is live — so a launch has to say so.
      queryClient.invalidateQueries(["scans", sessionId]);
      useAgentStreamStore.getState().markHistoryStale?.(sessionId);
      if (data.run?.runId) router.push(`/session/${sessionId}/scans/${data.run.runId}`);
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not start the scan")),
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
      <PageShell>
        <PageState state="loading" rows={4} />
      </PageShell>
    );
  }

  // A failed read and a case that is genuinely absent are different problems:
  // one has a retry, the other is answered by going back to the plan.
  if (planQuery.isError || !testCase) {
    return (
      <PageShell>
        <button
          className={vStyles.backButton}
          onClick={() => router.push(`/session/${sessionId}/test-plan`)}
        >
          <ArrowLeftOutlined /> All test cases
        </button>
        {planQuery.isError ? (
          <PageState
            state="error"
            title="Could not load the test plan"
            description="This case's details come from the plan. Its result and scan history are unchanged."
            onRetry={() => planQuery.refetch()}
          />
        ) : (
          <PageState
            state="empty"
            title={`Test case ${caseId} is not in this plan`}
            description="It was removed from the plan. Scans that ran against it keep their own record."
            actions={
              <Button onClick={() => router.push(`/session/${sessionId}/scans`)}>
                Scan history
              </Button>
            }
          />
        )}
      </PageShell>
    );
  }

  const activeScan = activeScanForCase(scans, testCase.testId);

  // Every launch from here is unattended: the case page promises "press Scan
  // and read the result", which is only true if the scan may clear its own
  // approval boundaries.
  const scanMenuItems = [
    {
      key: "category",
      label: `Scan whole category — ${testCase.categoryCode} (${categoryCases.length} cases)`,
      disabled: launchMutation.isLoading,
      onClick: () =>
        launchMutation.mutate({
          sessionId,
          testIds: categoryCases.map((one) => one.testId),
          label: `${testCase.categoryCode} — whole category`,
          policy: "unattended",
        }),
    },
    {
      key: "remaining",
      label: `Scan remaining in category (${remainingInCategory.length} not executed)`,
      disabled: launchMutation.isLoading || remainingInCategory.length === 0,
      onClick: () =>
        launchMutation.mutate({
          sessionId,
          testIds: remainingInCategory.map((one) => one.testId),
          label: `${testCase.categoryCode} — remaining`,
          policy: "unattended",
        }),
    },
  ];

  return (
    <PageShell>
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
              onClick={() =>
                launchMutation.mutate({
                  sessionId,
                  testIds: [testCase.testId],
                  label: `${testCase.testId} — ${testCase.title}`,
                  policy: "unattended",
                })
              }
            >
              Scan
            </Button>
            <Dropdown menu={{ items: scanMenuItems }} trigger={["click"]}>
              <Button icon={<CaretDownOutlined />} aria-label="More scan options" />
            </Dropdown>
          </div>
        </div>

        <div className={styles.caseHeroBody}>
          <div className={styles.caseBadges}>
            <span className={styles.caseIdPill}>{testCase.testId}</span>
            {testCase.categoryCode && (
              <span className={styles.caseCategoryChip}>{testCase.categoryCode}</span>
            )}
            {activeScan && (
              <span className={styles.activeRunBadge}>
                {activeScan.status === "queued"
                  ? `scan queued · #${activeScan.position ?? 1}`
                  : "scanning now"}
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

          {categoryCases.length > 1 && (
            <div className={styles.caseChapter}>
              <span className={styles.caseChapterLabel}>
                {testCase.categoryCode
                  ? `Chapter ${testCase.categoryCode}`
                  : "Other test cases"}
                {chapter?.name ? ` · ${chapter.name}` : ""}
              </span>
              <CaseMatrix
                rows={[
                  {
                    key: testCase.categoryCode || "OTHER",
                    label: chapter?.name ?? testCase.categoryCode,
                    cells: categoryCases.map((one) => ({
                      id: one.testId,
                      status: one.status,
                    })),
                  },
                ]}
                summary={{
                  passed: chapterCounts.passed,
                  failed: chapterCounts.failed,
                  blocked: chapterCounts.blocked,
                  in_progress: chapterCounts.inProgress,
                  skipped: chapterCounts.skipped,
                  not_started: chapterCounts.notStarted,
                }}
              />
            </div>
          )}
        </div>
      </header>

      <CaseScanList
        sessionId={sessionId}
        testCase={testCase}
        planCases={plan?.cases ?? []}
      />

      <div className={styles.caseDoc}>
        {/* The objective is the point of the case: it used to be guarded by
            `!testCase.objective`, so it rendered only when it was missing. */}
        <DocSection label="Objective">
          {testCase.objective || "Not described."}
        </DocSection>
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
    </PageShell>
  );
}
