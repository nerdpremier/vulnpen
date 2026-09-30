"use client";

import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Spin,
} from "antd";
import {
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  UpOutlined,
  RightOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  addCatalogueCases,
  getReportDraft,
  getTestPlan,
  removeTestCase,
  removeTestCases,
  updateTestCase,
} from "@/services/websecurity.service";
import { apiErrorMessage } from "@/utils/apiError";
import PlanSetupModal from "./PlanSetupModal";
import styles from "@/styles/pages/TestPlan.module.scss";

const STATUS_OPTIONS = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "blocked", label: "Blocked" },
  { value: "skipped", label: "Skipped" },
];

/** Colour the one status control by what it says, so no second status column is needed. */
const STATUS_TONE = {
  not_started: styles.statusToneIdle,
  in_progress: styles.statusToneActive,
  passed: styles.statusTonePassed,
  failed: styles.statusToneFailed,
  blocked: styles.statusToneBlocked,
  skipped: styles.statusToneIdle,
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "in_progress", label: "In progress" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "blocked", label: "Blocked" },
  { value: "not_started", label: "Not started" },
  { value: "skipped", label: "Skipped" },
];

/** Group key for cases that do not belong to one of the twelve WSTG categories. */
const OTHER_GROUP = "OTHER";

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

/** Execution totals for one set of cases. */
function summarise(cases) {
  const counts = { passed: 0, failed: 0, blocked: 0, inProgress: 0, skipped: 0, notStarted: 0 };
  for (const testCase of cases) {
    if (counts[testCase.status] !== undefined) counts[testCase.status] += 1;
  }
  const total = cases.length;
  const executed = counts.passed + counts.failed + counts.blocked;
  return { ...counts, total, executed, percent: total ? Math.round((executed / total) * 100) : 0 };
}

/**
 * The plan grouped by WSTG category, in catalogue order. Cases the assistant added by hand land in
 * a trailing "Other" group, and empty groups are dropped so no empty headings are drawn.
 */
function groupCases(cases, categories) {
  const groups = (categories ?? []).map((category) => ({
    key: category.code,
    code: category.code,
    section: category.section,
    name: category.name,
    cases: [],
  }));
  const position = new Map(groups.map((group, index) => [group.key, index]));
  const other = { key: OTHER_GROUP, code: "", section: "", name: "Other test cases", cases: [] };

  for (const testCase of cases) {
    const index = position.get(testCase.categoryCode);
    (index === undefined ? other : groups[index]).cases.push(testCase);
  }

  return [...groups, other].filter((group) => group.cases.length > 0);
}

function matchesFilters(testCase, needle, status) {
  if (status !== "all" && testCase.status !== status) return false;
  if (!needle) return true;
  return [testCase.testId, testCase.section, testCase.title, testCase.objective, testCase.observations]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

/** True when dropping a case would throw away something a tester recorded. */
function caseCarriesWork(testCase) {
  return (
    testCase.status !== "not_started" ||
    Boolean(testCase.observations?.trim()) ||
    Boolean(testCase.notes?.trim()) ||
    (testCase.linkedVulnerabilityIds?.length ?? 0) > 0
  );
}
export default function TestPlanPage({ sessionId }) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [editForm] = Form.useForm();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupOverrides, setGroupOverrides] = useState(() => new Map());
  const [expandedCase, setExpandedCase] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [addingCategory, setAddingCategory] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [editingCase, setEditingCase] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);

  const planQuery = useQuery(["test-plan", sessionId], () => getTestPlan(sessionId));

  const plan = planQuery.data?.plan ?? null;
  const catalog = planQuery.data?.catalog;
  const coverage = planQuery.data?.coverage ?? null;

  const groups = useMemo(
    () => groupCases(plan?.cases ?? [], catalog?.categories ?? []),
    [plan, catalog],
  );
  const catalogueIds = useMemo(
    () => new Set((catalog?.tests ?? []).map((test) => test.id)),
    [catalog],
  );
  const plannedIds = useMemo(
    () => new Set((plan?.cases ?? []).map((testCase) => testCase.testId.toUpperCase())),
    [plan],
  );
  // Catalogue cases per WSTG category, so a category can be completed in one click.
  const catalogueByCategory = useMemo(() => {
    const map = new Map();
    for (const test of catalog?.tests ?? []) {
      if (!map.has(test.category)) map.set(test.category, []);
      map.get(test.category).push(test.id);
    }
    return map;
  }, [catalog]);
  const missingCatalogueCases = (code) =>
    (catalogueByCategory.get(code) ?? []).filter((testId) => !plannedIds.has(testId));

  const needle = search.trim().toLowerCase();
  const filtersActive = statusFilter !== "all" || needle.length > 0;
  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          matches: group.cases.filter((testCase) =>
            matchesFilters(testCase, needle, statusFilter),
          ),
        }))
        .filter((group) => group.matches.length > 0),
    [groups, needle, statusFilter],
  );
  const matchCount = visibleGroups.reduce((sum, group) => sum + group.matches.length, 0);

  // The chips are the status filter: they show the counts the summary does, and toggle it.
  const chips = useMemo(() => {
    if (!coverage) return [];
    const counts = {
      all: coverage.total,
      in_progress: coverage.inProgress,
      passed: coverage.passed,
      failed: coverage.failed,
      blocked: coverage.blocked,
      not_started: coverage.notStarted,
      skipped: coverage.skipped,
    };
    return FILTERS.filter((filter) => filter.value === "all" || counts[filter.value] > 0).map(
      (filter) => ({ ...filter, count: counts[filter.value] }),
    );
  }, [coverage]);

  /**
   * Open when the user opened it; open while a filter is on, so matches are visible; otherwise
   * open only for the categories that already hold a failed or blocked case. A filter never writes
   * an override, so clearing it returns the plan to the calm, collapsed view.
   */
  const isGroupOpen = (group) => {
    if (groupOverrides.has(group.key)) return groupOverrides.get(group.key);
    if (filtersActive) return true;
    return group.cases.some(
      (testCase) => testCase.status === "failed" || testCase.status === "blocked",
    );
  };
  const allExpanded = groups.length > 0 && groups.every(isGroupOpen);

  const invalidate = () => {
    queryClient.invalidateQueries(["test-plan", sessionId]);
  };

  const addCasesMutation = useMutation(addCatalogueCases, {
    onSuccess: (data) => {
      const added = data?.added?.length ?? 0;
      message.success(`${added} test case${added === 1 ? "" : "s"} added to the plan`);
      invalidate();
    },
    onError: (error) =>
      message.error(apiErrorMessage(error, "Could not add the test cases")),
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
      setEditingCase(null);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not update the case")),
  });

  const removeCaseMutation = useMutation(removeTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testId} removed from the plan`);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not remove the case")),
  });

  const casesRemoveMutation = useMutation(removeTestCases, {
    onSuccess: (data) => {
      const removed = data?.removed?.length ?? 0;
      message.success(`${removed} case${removed === 1 ? "" : "s"} removed from the plan`);
      setSelectedIds(new Set());
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not remove the cases")),
  });

  const reportMutation = useMutation((id) => getReportDraft(id), {
    onSuccess: () => setReportOpen(true),
    onError: (error) =>
      message.error(apiErrorMessage(error, "Could not generate the report draft")),
  });

  const setGroupOpen = (targets, open) => {
    setGroupOverrides((previous) => {
      const next = new Map(previous);
      for (const group of targets) next.set(group.key, open);
      return next;
    });
  };

  const toggleGroup = (group) => setGroupOpen([group], !isGroupOpen(group));
  const expandAll = () => setGroupOpen(groups, true);
  const collapseAll = () => setGroupOpen(groups, false);

  const handleSearch = (value) => {
    setSearch(value);
    setSelectedIds(new Set());
  };

  const handleStatusFilter = (value) => {
    setStatusFilter(value);
    setSelectedIds(new Set());
  };

  const toggleSelected = (testId) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(testId)) next.delete(testId);
      else next.add(testId);
      return next;
    });
  };

  const setGroupSelected = (testIds, checked) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const testId of testIds) {
        if (checked) next.add(testId);
        else next.delete(testId);
      }
      return next;
    });
  };

  // One click fills a category with every WSTG case it is still missing.
  const addCategoryCases = (group, testIds) => {
    if (!testIds.length) return;
    setAddingCategory(group.key);
    addCasesMutation.mutate(
      { sessionId, testIds },
      { onSettled: () => setAddingCategory(null) },
    );
  };

  // A case nobody has worked on costs nothing to drop: it comes back with one click. Only stop for
  // a confirmation when recorded work would go with it.
  const requestRemoveCase = (testCase) => {
    if (!caseCarriesWork(testCase)) {
      removeCaseMutation.mutate({ sessionId, testId: testCase.testId });
      return;
    }
    modal.confirm({
      title: `Remove ${testCase.testId}?`,
      content:
        "This case carries recorded work - its status, observations and linked findings go with it. The report draft is built from this plan, so download it first if you need the record.",
      okText: "Remove",
      okButtonProps: { danger: true },
      onOk: () => removeCaseMutation.mutateAsync({ sessionId, testId: testCase.testId }),
    });
  };

  const confirmRemoveCases = (testIds, title) => {
    modal.confirm({
      title: title ?? `Remove ${testIds.length} ${testIds.length === 1 ? "case" : "cases"}?`,
      content:
        "These cases leave the plan together with anything recorded against them. The category they belong to can put them back in one click.",
      okText: `Remove ${testIds.length}`,
      okButtonProps: { danger: true },
      onOk: () => casesRemoveMutation.mutateAsync({ sessionId, testIds }),
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
          <p className={styles.headerContext}>
            {plan
              ? [
                  plan.target,
                  plan.scope,
                  `${plan.cases.length} cases in ${groups.length} categories`,
                ]
                  .filter(Boolean)
                  .join("  ·  ")
              : `The ${catalog?.totalTests ?? 97} WSTG v4.2 cases, ready to scope to this engagement.`}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            icon={<ReloadOutlined />}
            title="Refresh"
            loading={planQuery.isFetching}
            onClick={() => planQuery.refetch()}
          />
          <Button type="primary" icon={<SettingOutlined />} onClick={() => setSetupOpen(true)}>
            {plan ? "Plan setup" : "Set up plan"}
          </Button>
          <Button
            icon={<FileTextOutlined />}
            disabled={!plan}
            loading={reportMutation.isLoading}
            onClick={() => reportMutation.mutate(sessionId)}
          >
            Report
          </Button>
        </div>
      </header>

      {planQuery.isError && (
        <Alert type="error" showIcon message="Could not load the WSTG test plan" />
      )}

      {!plan && (
        <section className={styles.emptyState}>
          <h2>No test plan yet</h2>
          <p>
            Pick the WSTG categories this engagement covers and the plan is built from the catalogue,
            with the target and scope recorded alongside it.
          </p>
          <Button type="primary" icon={<SettingOutlined />} onClick={() => setSetupOpen(true)}>
            Set up the test plan
          </Button>
        </section>
      )}

      {plan && coverage && (
        <>
          <section className={styles.progress}>
            <div className={styles.progressHead}>
              <strong>{coverage.percentExecuted}%</strong>
              <span>
                {coverage.executed} of {coverage.total} cases executed
              </span>
              <span className={styles.progressBar}>
                <CoverageBar
                  value={coverage.percentExecuted}
                  tone={coverage.failed ? "barFailed" : "barPurple"}
                />
              </span>
            </div>
            <div className={styles.chips}>
              {chips.map((chip) => (
                <button
                  key={chip.value}
                  type="button"
                  className={`${styles.chip} ${
                    statusFilter === chip.value ? styles.chipActive : ""
                  }`}
                  onClick={() =>
                    handleStatusFilter(chip.value === statusFilter ? "all" : chip.value)
                  }
                >
                  {chip.label}
                  <b>{chip.count}</b>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.planCard}>
            <div className={styles.toolbar}>
              <Input
                allowClear
                value={search}
                onChange={(event) => handleSearch(event.target.value)}
                placeholder="Search test id, title, objective or observations"
                className={styles.search}
              />
              <div className={styles.toolbarRight}>
                <Button
                  size="small"
                  icon={allExpanded ? <UpOutlined /> : <DownOutlined />}
                  disabled={groups.length === 0}
                  onClick={allExpanded ? collapseAll : expandAll}
                >
                  {allExpanded ? "Collapse all" : "Expand all"}
                </Button>
              </div>
            </div>

            {selectedIds.size > 0 && (
              <div className={styles.selectionBar}>
                <span>{selectedIds.size} selected</span>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={casesRemoveMutation.isLoading}
                  onClick={() => confirmRemoveCases(Array.from(selectedIds))}
                >
                  Remove selected
                </Button>
                <Button size="small" type="text" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
              </div>
            )}

            {filtersActive && (
              <p className={styles.filterNote}>
                Showing {matchCount} of {plan.cases.length} cases
                {needle ? ` matching "${search.trim()}"` : ""}.
              </p>
            )}
            {visibleGroups.length === 0 ? (
              <div className={styles.centerState}>
                <Empty
                  description={
                    plan.cases.length
                      ? "No test cases match these filters"
                      : "No test cases in this plan - pick a category in Plan setup"
                  }
                />
              </div>
            ) : (
              <div className={styles.groups}>
                {visibleGroups.map((group) => {
                  const open = isGroupOpen(group);
                  const summary = summarise(group.cases);
                  const groupIds = group.matches.map((testCase) => testCase.testId);
                  const groupSelectedCount = groupIds.filter((testId) =>
                    selectedIds.has(testId),
                  ).length;
                  const missing = group.code ? missingCatalogueCases(group.code) : [];

                  return (
                    <div key={group.key} className={styles.group}>
                      <div className={styles.groupHeader}>
                        <button
                          type="button"
                          className={styles.groupToggle}
                          aria-expanded={open}
                          onClick={() => toggleGroup(group)}
                        >
                          {open ? (
                            <DownOutlined className={styles.chevron} />
                          ) : (
                            <RightOutlined className={styles.chevron} />
                          )}
                          <span className={styles.groupCode}>{group.code || "OTHER"}</span>
                          <span className={styles.groupName}>{group.name}</span>
                          <span className={styles.groupCount}>
                            {summary.executed}/{summary.total}
                          </span>
                        </button>

                        <span className={styles.groupBar}>
                          <CoverageBar
                            value={summary.percent}
                            tone={summary.failed ? "barFailed" : "barPurple"}
                          />
                        </span>

                        {summary.failed > 0 && (
                          <span className={`${styles.stat} ${styles.statFailed}`}>
                            {summary.failed} failed
                          </span>
                        )}
                        {summary.blocked > 0 && (
                          <span className={`${styles.stat} ${styles.statBlocked}`}>
                            {summary.blocked} blocked
                          </span>
                        )}

                        {missing.length > 0 && (
                          <Button
                            size="small"
                            type="text"
                            icon={<PlusOutlined />}
                            loading={addingCategory === group.key}
                            title={`Add the ${missing.length} remaining ${group.code} cases`}
                            onClick={() => addCategoryCases(group, missing)}
                          >
                            {missing.length}
                          </Button>
                        )}
                      </div>

                      {open && (
                        <div className={styles.tableWrap}>
                          <table className={styles.caseTable}>
                            <colgroup>
                              <col className={styles.colCheck} />
                              <col className={styles.colCode} />
                              <col className={styles.colCase} />
                              <col className={styles.colStatus} />
                              <col className={styles.colFindings} />
                              <col className={styles.colActions} />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>
                                  <Checkbox
                                    checked={
                                      groupIds.length > 0 &&
                                      groupSelectedCount === groupIds.length
                                    }
                                    indeterminate={
                                      groupSelectedCount > 0 &&
                                      groupSelectedCount < groupIds.length
                                    }
                                    onChange={(event) =>
                                      setGroupSelected(groupIds, event.target.checked)
                                    }
                                  />
                                </th>
                                <th>Test case</th>
                                <th>Objective</th>
                                <th>Result</th>
                                <th>Findings</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                                {group.matches.map((testCase) => {
                                  const isOpen = expandedCase === testCase.testId;
                                  const selected = selectedIds.has(testCase.testId);
                                  const rowClass = [
                                    isOpen ? styles.rowOpen : "",
                                    selected ? styles.rowSelected : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" ");
                                  const findings = testCase.linkedVulnerabilityIds?.length ?? 0;

                                  return (
                                    <React.Fragment key={testCase.testId}>
                                      <tr
                                        className={rowClass || undefined}
                                        onClick={() =>
                                          setExpandedCase(isOpen ? null : testCase.testId)
                                        }
                                      >
                                        <td onClick={(event) => event.stopPropagation()}>
                                          <Checkbox
                                            checked={selected}
                                            onChange={() => toggleSelected(testCase.testId)}
                                          />
                                        </td>
                                        <td>
                                          <span className={styles.caseCode}>{testCase.testId}</span>
                                          <span className={styles.caseSection}>
                                            {testCase.section || "hand added"}
                                          </span>
                                          {!catalogueIds.has(testCase.testId) && (
                                            <span className={styles.customTag}>custom</span>
                                          )}
                                        </td>
                                        <td>
                                          <strong className={styles.caseTitle}>
                                            {testCase.title}
                                          </strong>
                                          <span className={styles.caseObjective}>
                                            {testCase.objective}
                                          </span>
                                        </td>
                                        <td onClick={(event) => event.stopPropagation()}>
                                          <Select
                                            size="small"
                                            className={`${styles.statusSelect} ${
                                              STATUS_TONE[testCase.status] ?? ""
                                            }`}
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
                                        <td>
                                          {findings > 0 ? (
                                            <span className={styles.findingCount}>{findings}</span>
                                          ) : (
                                            <span className={styles.muted}>-</span>
                                          )}
                                        </td>
                                        <td
                                          className={styles.rowActions}
                                          onClick={(event) => event.stopPropagation()}
                                        >
                                          <Dropdown
                                            trigger={["click"]}
                                            menu={{
                                              items: [
                                                {
                                                  key: "edit",
                                                  icon: <EditOutlined />,
                                                  label: "Edit case",
                                                },
                                                { type: "divider" },
                                                {
                                                  key: "remove",
                                                  icon: <DeleteOutlined />,
                                                  danger: true,
                                                  label: "Remove from plan",
                                                },
                                              ],
                                              onClick: ({ key, domEvent }) => {
                                                domEvent.stopPropagation();
                                                if (key === "edit") openEdit(testCase);
                                                if (key === "remove") requestRemoveCase(testCase);
                                              },
                                            }}
                                          >
                                            <Button
                                              size="small"
                                              type="text"
                                              icon={<MoreOutlined />}
                                              title="Case actions"
                                            />
                                          </Dropdown>
                                        </td>
                                      </tr>
                                      {isOpen && (
                                        <tr className={styles.detailRow}>
                                          <td colSpan={6}>
                                            <div className={styles.detailGrid}>
                                              <div>
                                                <h4>Method</h4>
                                                <p>{testCase.howToTest || "Not described."}</p>
                                              </div>
                                              <div>
                                                <h4>Expected evidence</h4>
                                                <p>
                                                  {testCase.evidenceExpectation || "Not described."}
                                                </p>
                                              </div>
                                              <div>
                                                <h4>Tools</h4>
                                                <p>{(testCase.tools ?? []).join(", ") || "-"}</p>
                                              </div>
                                              <div className={styles.detailWide}>
                                                <h4>Observations recorded</h4>
                                                <p>
                                                  {testCase.observations || "Nothing recorded yet."}
                                                </p>
                                                {testCase.notes && (
                                                  <p className={styles.muted}>
                                                    Notes: {testCase.notes}
                                                  </p>
                                                )}
                                                {findings > 0 && (
                                                  <p className={styles.muted}>
                                                    Linked findings:{" "}
                                                    {testCase.linkedVulnerabilityIds.join(", ")}
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
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {setupOpen && (
        <PlanSetupModal
          sessionId={sessionId}
          plan={plan}
          catalog={catalog}
          onClose={() => setSetupOpen(false)}
          onSaved={invalidate}
        />
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
        open={Boolean(editingCase)}
        onCancel={() => setEditingCase(null)}
        title={`Edit test case ${editingCase?.testId ?? ""}`}
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
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}