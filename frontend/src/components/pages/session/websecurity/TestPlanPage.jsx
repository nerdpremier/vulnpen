"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "react-query";
import {
  App,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Select,
} from "antd";
import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileTextOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  UpOutlined,
  RightOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  getTestPlan,
  removeTestCase,
  removeTestCases,
  updateTestCase,
} from "@/services/websecurity.service";
import { getSessionInfo } from "@/services/agent.service";
import { apiErrorMessage } from "@/utils/apiError";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import PlanSetupModal from "./PlanSetupModal";
import ScanLauncherModal from "../scans/ScanLauncherModal";
import styles from "@/styles/pages/TestPlan.module.scss";
import { PageState } from "@/components/common/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { summarise, groupCases, matchesFilters, caseCarriesWork, STATUS_OPTIONS } from "@/utils/testPlan.mjs";
import { testPlanKey } from "@/utils/scanQueryKeys.mjs";

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

/**
 * The engagement boundary as chips. It used to be a sentence that repeated the
 * target and the scope in prose; the two facts are labels, so they are badges.
 */
function PlanChips({ target, scope }) {
  if (!target && !scope) return null;
  return (
    <div className={styles.scopeChips}>
      {target && (
        <span className={styles.scopeChip}>
          <span className={styles.scopeChipLabel}>Target</span>
          <span className={styles.scopeChipValue} title={target}>
            {target}
          </span>
        </span>
      )}
      {scope && (
        <span className={styles.scopeChip}>
          <span className={styles.scopeChipLabel}>Scope</span>
          <span className={styles.scopeChipValue} title={scope}>
            {scope}
          </span>
        </span>
      )}
    </div>
  );
}

/* One segment per outcome; the remainder of the track is what the category has
   not reached yet. Selected by key, so the tone map cannot drift from the
   legend the rest of the product uses. */
const CATEGORY_SEGMENTS = [
  { key: "passed", tone: "segPassed" },
  { key: "failed", tone: "segFailed" },
  { key: "blocked", tone: "segBlocked" },
  { key: "inProgress", tone: "segActive" },
  { key: "skipped", tone: "segSkipped" },
  { key: "notStarted", tone: "" },
];

const SEGMENT_LABEL = {
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  inProgress: "in progress",
  skipped: "skipped",
  notStarted: "not started",
};

/**
 * A category's outcome as one proportional bar.
 *
 * The header used to carry a plain fill bar plus "8 failed" / "2 blocked"
 * pills; the bar said how much was done, the pills said how it went, and the
 * two had to be read together. One segmented bar carries both, and the counts
 * stay available by tooltip and to a screen reader.
 */
function CategoryBar({ code, name, summary }) {
  const segments = CATEGORY_SEGMENTS.map((segment) => ({
    ...segment,
    value: summary[segment.key] ?? 0,
  })).filter((segment) => segment.value > 0);

  const title = `${code ? `${code} — ` : ""}${name}: ${summary.executed}/${
    summary.total
  } settled — ${segments
    .map((segment) => `${segment.value} ${SEGMENT_LABEL[segment.key]}`)
    .join(", ")}`;

  return (
    <span
      className={styles.groupBar}
      role="img"
      aria-label={title}
      title={title}
    >
      {summary.total === 0 ? (
        <span className={styles.groupSegEmpty} />
      ) : (
        segments.map((segment) => (
          <span
            key={segment.key}
            className={[styles.groupSeg, segment.tone ? styles[segment.tone] : ""]
              .filter(Boolean)
              .join(" ")}
            style={{ flexGrow: segment.value }}
          />
        ))
      )}
    </span>
  );
}

export default function TestPlanPage({ sessionId }) {
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const queryClient = useQueryClient();
  const [editForm] = Form.useForm();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupOverrides, setGroupOverrides] = useState(() => new Map());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [setupOpen, setSetupOpen] = useState(false);
  // The cases the selection bar wants to scan; null = launcher closed.
  const [scanSelection, setScanSelection] = useState(null);
  const [editingCase, setEditingCase] = useState(null);

  // A finding deep-links here as ?case=WSTG-ATHN-01. The request is read from the
  // URL and held as derived state, so opening the plan never needs a sync effect:
  // the category opens, the case expands and the row is scrolled into view.
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedCaseId = (searchParams.get("case") || "").trim().toUpperCase();
  const [focusDismissed, setFocusDismissed] = useState(false);
  const focusCaseId = focusDismissed ? "" : requestedCaseId;

  const planQuery = useQuery(testPlanKey(sessionId), () => getTestPlan(sessionId));

  // The engagement boundary is captured when the session is created; the setup
  // screen edits those same values, so it starts from them instead of blank.
  const { data: sessionInfo } = useQuery(["session-info", sessionId], () =>
    getSessionInfo(sessionId),
  );
  const engagement = sessionInfo?.engagement ?? null;

  const plan = planQuery.data?.plan ?? null;
  const catalog = planQuery.data?.catalog;
  const coverage = planQuery.data?.coverage ?? null;

  /** The case a finding pointed at, once the plan has loaded. */
  const focusedCase = useMemo(() => {
    if (!focusCaseId) return null;
    return (
      (plan?.cases ?? []).find(
        (testCase) => testCase.testId.toUpperCase() === focusCaseId,
      ) ?? null
    );
  }, [plan, focusCaseId]);

  const clearFocus = () => {
    setFocusDismissed(true);
    router.replace(`/session/${sessionId}/test-plan`);
  };

  // Scrolling is the one thing that needs the DOM, so it is the only effect:
  // no state is written here, which keeps renders cascaded-free.
  useEffect(() => {
    if (!focusedCase) return undefined;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`case-${focusedCase.testId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedCase]);

  const groups = useMemo(
    () => groupCases(plan?.cases ?? [], catalog?.categories ?? []),
    [plan, catalog],
  );

  // Keep the selection honest: drop ids that are no longer part of the plan
  // (removed via the row menu, plan regeneration, ...), so batch actions never
  // hit cases that do not exist any more. Derived during render instead of
  // synced by an effect, so stale ids never reach the UI.
  const activeSelectedIds = useMemo(() => {
    if (selectedIds.size === 0) return selectedIds;
    const planned = new Set((plan?.cases ?? []).map((c) => c.testId));
    const next = new Set([...selectedIds].filter((id) => planned.has(id)));
    return next;
  }, [selectedIds, plan]);

  const catalogueIds = useMemo(
    () => new Set((catalog?.tests ?? []).map((test) => test.id)),
    [catalog],
  );

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
    if (
      focusCaseId &&
      group.cases.some(
        (testCase) => testCase.testId.toUpperCase() === focusCaseId,
      )
    ) {
      return true;
    }
    return group.cases.some(
      (testCase) => testCase.status === "failed" || testCase.status === "blocked",
    );
  };
  const allExpanded = groups.length > 0 && groups.every(isGroupOpen);

  const invalidate = () => {
    queryClient.invalidateQueries(testPlanKey(sessionId));
    // Setup writes the engagement boundary too, so the cached values the modal
    // starts from have to be refreshed alongside the plan.
    queryClient.invalidateQueries(["session-info", sessionId]);
  };

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
      // Drop the removed id from the selection so the selection bar can't
      // reference a case that is no longer part of the plan.
      setSelectedIds((prev) => {
        if (!prev.has(data.testId)) return prev;
        const next = new Set(prev);
        next.delete(data.testId);
        return next;
      });
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

  // A case nobody has worked on costs nothing to drop: it comes back with one click. Only stop for
  // a confirmation when recorded work would go with it.
  const requestRemoveCase = (testCase) => {
    if (!caseCarriesWork(testCase)) {
      removeCaseMutation.mutate({ sessionId, testId: testCase.testId });
      return;
    }
    confirmPopUp({
      title: `Remove ${testCase.testId}?`,
      content:
        "This case carries recorded work - its status, observations and linked findings go with it. The report draft is built from this plan, so download it first if you need the record.",
      okText: "Remove",
      onOk: () => removeCaseMutation.mutateAsync({ sessionId, testId: testCase.testId }),
    });
  };

  const confirmRemoveCases = (testIds, title) => {
    confirmPopUp({
      title: title ?? `Remove ${testIds.length} ${testIds.length === 1 ? "case" : "cases"}?`,
      okText: `Remove ${testIds.length}`,
      onOk: () => casesRemoveMutation.mutateAsync({ sessionId, testIds }),
    });
  };

  const openEdit = (testCase) => {
    setEditingCase(testCase);
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
      testId: editingCase.testId,
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
      <div className={styles.page}>
        <PageState state="loading" rows={5} />
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>OWASP WSTG v{catalog?.version ?? "4.2"}</span>
          <h1>Web Application Security Testing</h1>
          {/* The plan's own boundary when it exists, the session's before that. */}
          <PlanChips
            target={plan?.target || engagement?.target}
            scope={plan?.scope || engagement?.scope}
          />
        </div>
        <div className={styles.headerActions}>
          <Button
            icon={<ReloadOutlined />}
            title="Refresh"
            loading={planQuery.isFetching}
            onClick={() => planQuery.refetch()}
          />
          <Button
            icon={<PlayCircleOutlined />}
            disabled={!plan}
            title="Launch and follow scans of this plan"
            onClick={() => router.push(`/session/${sessionId}/scans`)}
          >
            Scans
          </Button>
          <Button
            type="primary"
            icon={<SettingOutlined />}
            // Never open setup on a plan we could not read: the modal would
            // start from an empty selection and save over the real one.
            disabled={planQuery.isError || planQuery.isLoading}
            onClick={() => setSetupOpen(true)}
          >
            {plan ? "Plan setup" : "Set up plan"}
          </Button>
          <Button
            icon={<FileTextOutlined />}
            disabled={!plan}
            onClick={() => router.push(`/session/${sessionId}/report`)}
          >
            Report
          </Button>
        </div>
      </header>

      {/*
        A failed read is not an empty plan. The old markup painted an Alert and
        still offered "Set up the test plan", which opens the setup modal with
        no plan loaded — every catalogue case pre-ticked and no drop warning —
        so one failed refresh could silently widen a scoped plan to all 97
        cases. The two states are now mutually exclusive.
      */}
      {planQuery.isError ? (
        <PageState
          state="error"
          title="Could not load the WSTG test plan"
          description="Retry before opening plan setup: rebuilding from here would replace the case selection."
          onRetry={() => planQuery.refetch()}
        />
      ) : planQuery.isSuccess && !plan ? (
        <PageState
          state="empty"
          title="No test plan yet"
          description={`Pick the WSTG chapters this engagement covers and the plan is built from the ${
            catalog?.totalTests ?? 97
          }-case catalogue, with the target and scope recorded alongside it.`}
          actions={
            <Button
              type="primary"
              icon={<SettingOutlined />}
              onClick={() => setSetupOpen(true)}
            >
              Set up the test plan
            </Button>
          }
        />
      ) : null}

      {plan && coverage && (
        <>
          {/* The proportions live here; the chapters below show where work is thin. */}
          <section className={styles.coverage} aria-label="Plan outcomes">
            <div className={styles.outcomeHeading}>
              <div>
                <span className={styles.eyebrow}>PLAN OUTCOMES</span>
                <h2>Every case, one result</h2>
              </div>
              <span className={styles.outcomeTotal}>
                <strong>{coverage.executed}</strong> / {coverage.total} executed
              </span>
            </div>
            <div
              className={styles.outcomeTrack}
              role="img"
              aria-label={CATEGORY_SEGMENTS.map((segment) =>
                `${coverage[segment.key] ?? 0} ${SEGMENT_LABEL[segment.key]}`,
              ).join(", ")}
            >
              {CATEGORY_SEGMENTS.filter((segment) => coverage[segment.key] > 0).map(
                (segment) => (
                  <span
                    key={segment.key}
                    className={`${styles.outcomeSegment} ${styles[segment.tone || "segUnstarted"]}`}
                    style={{ flexGrow: coverage[segment.key] }}
                    title={`${coverage[segment.key]} ${SEGMENT_LABEL[segment.key]}`}
                  />
                ),
              )}
            </div>
            <p className={styles.outcomeHint}>
              Select a result below to inspect its cases; open a chapter for the detail.
            </p>
          </section>

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
                {chip.value !== "all" && (
                  <span className={styles.chipSwatch} data-status={chip.value} aria-hidden="true" />
                )}
                {chip.label}
                <b>{chip.count}</b>
              </button>
            ))}
          </div>

          <section className={styles.planCard}>
            {requestedCaseId && (
              <div className={styles.focusBanner}>
                <span className={styles.focusLabel}>
                  {focusedCase ? "Opened from a finding" : "Not in this plan"}
                </span>
                <span className={styles.focusCase}>{requestedCaseId}</span>
                {focusedCase && (
                  <span className={styles.focusTitle}>{focusedCase.title}</span>
                )}
                {!focusedCase && (
                  <span className={styles.focusTitle}>
                    Add this case in Plan setup to record its result here.
                  </span>
                )}
                <button
                  type="button"
                  className={styles.focusClear}
                  onClick={clearFocus}
                >
                  Clear
                </button>
              </div>
            )}
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

            {activeSelectedIds.size > 0 && (
              <div className={styles.selectionBar}>
                <span>{activeSelectedIds.size} selected</span>
                {/* The plan is where cases are chosen, so it is also where a
                    scan of them starts: the launcher opens on this selection
                    instead of making the operator re-pick it. */}
                <Button
                  size="small"
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  disabled={planQuery.isError}
                  onClick={() => setScanSelection(Array.from(activeSelectedIds))}                >
                  Scan selected
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={casesRemoveMutation.isLoading}
                  onClick={() => confirmRemoveCases(Array.from(activeSelectedIds))}
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
                    activeSelectedIds.has(testId),
                  ).length;

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

                        <CategoryBar
                          code={group.code}
                          name={group.name}
                          summary={summary}
                        />
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
                                <th>Title</th>
                                <th>Result</th>
                                <th>Findings</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                                {group.matches.map((testCase) => {
                                  const isFocused =
                                    focusCaseId === testCase.testId;
                                  const selected = activeSelectedIds.has(testCase.testId);
                                  const rowClass = [
                                    selected ? styles.rowSelected : "",
                                    isFocused ? styles.rowFocused : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" ");
                                  const findings = testCase.linkedVulnerabilityIds?.length ?? 0;

                                  return (
                                    <tr
                                      key={testCase.testId}
                                      id={`case-${testCase.testId}`}
                                      className={rowClass || undefined}
                                      onClick={() => {
                                        // Collapsing the deep-linked case also
                                        // releases the focus, so it does not
                                        // spring back open.
                                        if (isFocused) setFocusDismissed(true);
                                        router.push(
                                          `/session/${sessionId}/test-plan/${testCase.testId}`,
                                        );
                                      }}
                                    >
                                      <td onClick={(event) => event.stopPropagation()}>
                                        <Checkbox
                                          checked={selected}
                                          onChange={() => toggleSelected(testCase.testId)}
                                        />
                                      </td>
                                      <td>
                                        <span className={styles.caseCode}>{testCase.testId}</span>
                                      </td>
                                      <td>
                                        <strong className={styles.caseTitle}>
                                          {testCase.title}
                                        </strong>
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
                                        <td
                                          onClick={(event) =>
                                            event.stopPropagation()
                                          }
                                        >
                                          {findings > 0 ? (
                                            <Link
                                              href={
                                                testCase.linkedVulnerabilityIds
                                                  ?.length === 1
                                                  ? `/session/${sessionId}/vulnerabilities/${testCase.linkedVulnerabilityIds[0]}`
                                                  : `/session/${sessionId}/vulnerabilities`
                                              }
                                              className={styles.findingLink}
                                              title="Open the finding recorded for this case"
                                            >
                                              {findings}
                                            </Link>
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

      {setupOpen && planQuery.isSuccess && (
        <PlanSetupModal
          sessionId={sessionId}
          plan={plan}
          catalog={catalog}
          engagement={engagement}
          onClose={() => setSetupOpen(false)}
          onSaved={invalidate}
        />
      )}

      {scanSelection?.length > 0 && plan && (
        <ScanLauncherModal
          sessionId={sessionId}
          plan={plan}
          initialTestIds={scanSelection}
          onClose={() => setScanSelection(null)}
          onLaunched={(run) => {
            setScanSelection(null);
            if (run?.runId) router.push(`/session/${sessionId}/scans/${run.runId}`);
          }}
        />
      )}

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
