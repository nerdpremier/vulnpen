"use client";

import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { Alert, App, Button, Empty, Form, Input, Modal, Select, Spin } from "antd";
import {
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  addTestCase,
  generateTestPlan,
  getReportDraft,
  getTestPlan,
  updateTestCase,
} from "@/services/websecurity.service";
import styles from "@/styles/pages/TestPlan.module.scss";

const STATUS_OPTIONS = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "blocked", label: "Blocked" },
  { value: "skipped", label: "Skipped" },
];

const STATUS_STYLE = {
  not_started: styles.statusNotStarted,
  in_progress: styles.statusInProgress,
  passed: styles.statusPassed,
  failed: styles.statusFailed,
  blocked: styles.statusBlocked,
  skipped: styles.statusSkipped,
};

function CoverageBar({ value, tone }) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span className={styles.bar}>
      <span
        className={`${styles.barFill} ${tone ? styles[tone] : ""}`}
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}

export default function TestPlanPage({ sessionId }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [addForm] = Form.useForm();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingCase, setEditingCase] = useState(null);

  const planQuery = useQuery(["test-plan", sessionId], () => getTestPlan(sessionId));

  const plan = planQuery.data?.plan ?? null;
  const catalog = planQuery.data?.catalog;
  const coverage = planQuery.data?.coverage ?? null;

  const invalidate = () => {
    queryClient.invalidateQueries(["test-plan", sessionId]);
  };

  const generateMutation = useMutation(generateTestPlan, {
    onSuccess: (data) => {
      message.success(
        `Test plan ready: ${data.plan?.cases?.length ?? 0} WSTG v4.2 test cases (${data.added ?? 0} added, ${data.kept ?? 0} kept).`,
      );
      invalidate();
    },
    onError: (error) =>
      message.error(error?.response?.data?.message || "Could not build the test plan"),
  });

  const addCaseMutation = useMutation(addTestCase, {
    onSuccess: (data) => {
      message.success(`Test case ${data.testCase?.testId ?? ""} added`);
      setAddOpen(false);
      addForm.resetFields();
      invalidate();
    },
    onError: (error) =>
      message.error(error?.response?.data?.message || "Could not add the test case"),
  });

  const updateCaseMutation = useMutation(updateTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testCase?.testId} updated`);
      setEditingCase(null);
      invalidate();
    },
    onError: (error) =>
      message.error(error?.response?.data?.message || "Could not update the test case"),
  });

  const statusMutation = useMutation(updateTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testCase?.testId} → ${data.testCase?.status}`);
      invalidate();
    },
    onError: (error) =>
      message.error(error?.response?.data?.message || "Could not update the test case"),
  });

  const reportMutation = useMutation((id) => getReportDraft(id), {
    onSuccess: () => setReportOpen(true),
    onError: (error) =>
      message.error(error?.response?.data?.message || "Could not generate the report draft"),
  });

  const filtered = useMemo(() => {
    const cases = plan?.cases ?? [];
    const needle = search.trim().toLowerCase();
    return cases
      .filter((testCase) => statusFilter === "all" || testCase.status === statusFilter)
      .filter(
        (testCase) => categoryFilter === "all" || testCase.categoryCode === categoryFilter,
      )
      .filter((testCase) => {
        if (!needle) return true;
        return [testCase.testId, testCase.title, testCase.objective, testCase.observations]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      });
  }, [plan, search, statusFilter, categoryFilter]);

  const handleGenerate = (values) => {
    generateMutation.mutate({
      sessionId,
      target: values.target?.trim() || undefined,
      scope: values.scope?.trim() || undefined,
      categories: values.categories?.length ? values.categories : undefined,
    });
  };

  const handleAddCase = (values) => {
    addCaseMutation.mutate({
      sessionId,
      action: "add_case",
      title: values.title?.trim(),
      objective: values.objective?.trim() || undefined,
      howToTest: values.howToTest?.trim() || undefined,
      categoryCode: values.categoryCode || undefined,
    });
  };

  const openEdit = (testCase) => {
    setEditingCase(testCase);
    editForm.setFieldsValue({
      title: testCase.title,
      objective: testCase.objective,
      howToTest: testCase.howToTest,
      notes: testCase.notes,
    });
  };

  const handleEditCase = (values) => {
    updateCaseMutation.mutate({
      sessionId,
      testId: editingCase.testId,
      action: "update_case",
      title: values.title?.trim(),
      objective: values.objective?.trim() || undefined,
      howToTest: values.howToTest?.trim() || undefined,
      notes: values.notes?.trim() || undefined,
    });
  };

  const report = reportMutation.data?.report;
  const copyReport = async () => {
    if (!report?.markdown) return;
    try {
      await navigator.clipboard.writeText(report.markdown);
      message.success("Report markdown copied");
    } catch {
      message.error("Could not copy to the clipboard");
    }
  };

  const downloadReport = () => {
    if (!report?.markdown) return;
    const blob = new Blob([report.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = report.fileName || "web-app-pentest-report.md";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (planQuery.isLoading) {
    return (
      <div className={styles.fullState}>
        <Spin />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>OWASP WSTG v{catalog?.version ?? "4.2"}</span>
          <h1>Web Application Security Testing</h1>
          <p>
            {plan
              ? `${plan.cases.length} test cases planned for ${plan.target || "this engagement"} — execute each case, record the result, and the draft report follows from the evidence.`
              : "Generate a WSTG v4.2 test plan to drive the assessment, then track every case as it is executed."}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => planQuery.refetch()}
            loading={planQuery.isFetching}
          >
            Refresh
          </Button>
          <Button
            icon={<PlusOutlined />}
            disabled={!plan}
            onClick={() => {
              addForm.resetFields();
              setAddOpen(true);
            }}
          >
            Add custom case
          </Button>
          <Button
            type="primary"
            icon={<FileTextOutlined />}
            disabled={!plan}
            loading={reportMutation.isLoading}
            onClick={() => reportMutation.mutate(sessionId)}
          >
            Generate report draft
          </Button>
        </div>
      </header>

      {planQuery.isError && (
        <Alert type="error" showIcon message="Could not load the WSTG test plan" />
      )}

      {!plan && (
        <section className={styles.setupCard}>
          <h2>Plan the assessment</h2>
          <p className={styles.muted}>
            {catalog?.totalTests ?? 97} WSTG v{catalog?.version ?? "4.2"} test cases are available
            across {(catalog?.categories ?? []).length} categories. Restrict to specific categories
            if the engagement only covers part of the application.
          </p>
          <Form form={form} layout="vertical" onFinish={handleGenerate}>
            <div className={styles.setupGrid}>
              <Form.Item
                label="Target"
                name="target"
                rules={[{ required: true, message: "Enter the target under test" }]}
              >
                <Input placeholder="https://app.example.com" />
              </Form.Item>
              <Form.Item label="Scope" name="scope">
                <Input placeholder="Storefront, REST API, user and admin roles" />
              </Form.Item>
              <Form.Item label="Restrict to categories (optional)" name="categories">
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="All WSTG categories"
                  options={(catalog?.categories ?? []).map((category) => ({
                    value: category.code,
                    label: `${category.section} ${category.name}`,
                  }))}
                />
              </Form.Item>
            </div>
            <Button type="primary" htmlType="submit" loading={generateMutation.isLoading}>
              Generate WSTG test plan
            </Button>
          </Form>
        </section>
      )}

      {plan && coverage && (
        <>
          <section className={styles.metrics}>
            <div className={styles.metric}>
              <span>Executed</span>
              <strong>{coverage.percentExecuted}%</strong>
              <small>{coverage.executed}/{coverage.total} cases</small>
            </div>
            <div className={styles.metric}>
              <span>Passed</span>
              <strong className={styles.tonePassed}>{coverage.passed}</strong>
              <small>no weakness confirmed</small>
            </div>
            <div className={styles.metric}>
              <span>Failed</span>
              <strong className={styles.toneFailed}>{coverage.failed}</strong>
              <small>produced findings</small>
            </div>
            <div className={styles.metric}>
              <span>Blocked</span>
              <strong className={styles.toneBlocked}>{coverage.blocked}</strong>
              <small>needs access or data</small>
            </div>
            <div className={styles.metric}>
              <span>Not started</span>
              <strong>{coverage.notStarted}</strong>
              <small>unverified risk</small>
            </div>
          </section>

          {coverage.byCategory?.length > 0 && (
            <section className={styles.panels}>
              <div className={styles.panel}>
                <h3>Coverage by WSTG category</h3>
                <ul className={styles.coverageList}>
                  {coverage.byCategory.map((row) => (
                    <li key={row.key}>
                      <span className={styles.coverageLabel}>
                        <strong>{row.key}</strong> {row.label}
                      </span>
                      <CoverageBar
                        value={row.total ? (row.executed / row.total) * 100 : 0}
                        tone="barPurple"
                      />
                      <span className={styles.coverageValue}>
                        {row.executed}/{row.total}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className={styles.tableCard}>
            <div className={styles.toolbar}>
              <Input
                allowClear
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search test id, title, objective or observations"
                className={styles.search}
              />
              <Select
                value={statusFilter}
                onChange={setStatusFilter}
                className={styles.filter}
                options={[
                  { value: "all", label: "All statuses" },
                  ...STATUS_OPTIONS,
                ]}
              />
              <Select
                value={categoryFilter}
                onChange={setCategoryFilter}
                className={styles.filter}
                options={[
                  { value: "all", label: "All categories" },
                  ...(catalog?.categories ?? []).map((category) => ({
                    value: category.code,
                    label: category.name,
                  })),
                ]}
              />
            </div>

            {filtered.length === 0 ? (
              <div className={styles.centerState}>
                <Empty description="No test cases match these filters" />
              </div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Test case</th>
                      <th>Objective</th>
                      <th>Status</th>
                      <th>Findings</th>
                      <th>Record result</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((testCase) => {
                      const isOpen = expandedId === testCase.testId;
                      return (
                        <React.Fragment key={testCase.testId}>
                          <tr
                            className={isOpen ? styles.rowOpen : undefined}
                            onClick={() => setExpandedId(isOpen ? null : testCase.testId)}
                          >
                            <td>
                              <span className={styles.caseCode}>{testCase.testId}</span>
                              <span className={styles.caseSection}>{testCase.section}</span>
                            </td>
                            <td>
                              <strong className={styles.caseTitle}>{testCase.title}</strong>
                              <span className={styles.caseObjective}>{testCase.objective}</span>
                            </td>
                            <td>
                              <span
                                className={`${styles.statusPill} ${STATUS_STYLE[testCase.status] ?? ""}`}
                              >
                                {String(testCase.status).replace("_", " ")}
                              </span>
                            </td>
                            <td>
                              {testCase.linkedVulnerabilityIds?.length ? (
                                <span className={styles.findingCount}>
                                  {testCase.linkedVulnerabilityIds.length}
                                </span>
                              ) : (
                                <span className={styles.muted}>—</span>
                              )}
                            </td>
                            <td onClick={(event) => event.stopPropagation()}>
                              <Select
                                size="small"
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
                            </td>
                            <td onClick={(event) => event.stopPropagation()}>
                              <Button
                                size="small"
                                type="text"
                                icon={<EditOutlined />}
                                onClick={() => openEdit(testCase)}
                              >
                                Edit
                              </Button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className={styles.detailRow}>
                              <td colSpan={6}>
                                <div className={styles.detailGrid}>
                                  <div>
                                    <h4>Method</h4>
                                    <p>{testCase.howToTest}</p>
                                  </div>
                                  <div>
                                    <h4>Expected evidence</h4>
                                    <p>{testCase.evidenceExpectation}</p>
                                  </div>
                                  <div>
                                    <h4>Tools</h4>
                                    <p>{(testCase.tools ?? []).join(", ") || "—"}</p>
                                  </div>
                                  <div className={styles.detailWide}>
                                    <h4>Observations recorded</h4>
                                    <p>{testCase.observations || "Nothing recorded yet."}</p>
                                    {testCase.notes && <p className={styles.muted}>Notes: {testCase.notes}</p>}
                                    {testCase.linkedVulnerabilityIds?.length > 0 && (
                                      <p className={styles.muted}>
                                        Linked findings: {testCase.linkedVulnerabilityIds.join(", ")}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <Modal
        open={reportOpen}
        onCancel={() => setReportOpen(false)}
        width={980}
        title={report?.title ?? "Draft report"}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={copyReport}>
            Copy markdown
          </Button>,
          <Button key="download" icon={<DownloadOutlined />} onClick={downloadReport}>
            Download .md
          </Button>,
          <Button key="close" type="primary" onClick={() => setReportOpen(false)}>
            Close
          </Button>,
        ]}
      >
        {report && (
          <div className={styles.reportMeta}>
            <span>{report.fileName}</span>
            <span>{report.stats?.totalFindings ?? 0} findings</span>
            <span>
              {report.stats?.coverage?.executed ?? 0}/{report.stats?.coverage?.total ?? 0} WSTG
              cases executed
            </span>
            <span>{report.stats?.unmapped ?? 0} unmapped</span>
          </div>
        )}
        <div className={styles.reportBody}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report?.markdown ?? ""}</ReactMarkdown>
        </div>
      </Modal>

      <Modal
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        title="Add custom test case"
        confirmLoading={addCaseMutation.isLoading}
        okText="Add case"
        onOk={() => addForm.submit()}
      >
        <Form form={addForm} layout="vertical" onFinish={handleAddCase}>
          <Form.Item
            label="Title"
            name="title"
            rules={[{ required: true, message: "Enter a title for the test case" }]}
          >
            <Input placeholder="e.g. Check password reset rate limiting" />
          </Form.Item>
          <Form.Item label="Objective (optional)" name="objective">
            <Input.TextArea
              rows={2}
              placeholder="What this test aims to verify"
            />
          </Form.Item>
          <Form.Item label="How to test (optional)" name="howToTest">
            <Input.TextArea
              rows={3}
              placeholder="Steps, tools and requests to run"
            />
          </Form.Item>
          <Form.Item label="Category (optional)" name="categoryCode">
            <Select
              allowClear
              placeholder="WSTG category"
              options={(catalog?.categories ?? []).map((category) => ({
                value: category.code,
                label: `${category.section} ${category.name}`,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(editingCase)}
        onCancel={() => setEditingCase(null)}
        title={`Edit test case ${editingCase?.testId ?? ""}`}
        confirmLoading={updateCaseMutation.isLoading}
        okText="Save changes"
        onOk={() => editForm.submit()}
      >
        <Form form={editForm} layout="vertical" onFinish={handleEditCase}>
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
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
