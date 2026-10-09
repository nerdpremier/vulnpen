"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "react-query";
import { Button, Checkbox, Dropdown, Empty, Form, Input, Modal, Select, Tooltip } from "antd";
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
import { getTestPlan } from "@/services/websecurity.service";
import { getSessionInfo } from "@/services/agent.service";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import PlanSetupModal from "./PlanSetupModal";
import PlanTerrain from "./PlanTerrain";
import ScanLauncherModal from "../scans/ScanLauncherModal";
import styles from "@/styles/pages/TestPlan.module.scss";
import { PageShell, PageState } from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { summarise, groupCases, matchesFilters, caseCarriesWork, STATUS_OPTIONS, activeSelection, toggledSelection, selectionWith, groupIsOpen, coverageChips } from "@/utils/testPlan.mjs";
import { usePlanMutations } from "@/hooks/usePlanMutations";
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
 * The plan as a landscape of towers, drawn in three dimensions.
 *
 * The header used to spell the plan out as a sentence and a single wide bar —
 * one number repeated twice, and no way to see which chapter was thin. The
 * terrain puts every chapter on the ground: a tower is a chapter, each course
 * of blocks is one of its cases, and the colour of a course is the result it
 * settled. Height says how much a chapter holds; colour says how it went; and
 * the chapter that carries failures has red at its base. Hover a tower to name
 * it, click one to read it out in the ledger beside it.
 */
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
 * One chapter as a ledger row: its name, the bar that draws its outcome, and
 * the plain caption that says what the bar means.
 *
 * The header used to carry `9/18` beside the name and a segmented bar with no
 * scale of its own, so a reader had to pair a bare ratio with a colour key
 * held somewhere else. The row now names what it counted under the bar and
 * moves the raw ratio into the tooltip a screen reader already had.
 */
function ChapterRow({ group, lit, open, onToggle, onFocus, onBlur }) {
  const summary = summarise(group.cases);
  const segments = CATEGORY_SEGMENTS.map((segment) => ({
    ...segment,
    value: summary[segment.key] ?? 0,
  })).filter((segment) => segment.value > 0);

  const label = `${group.code ? `${group.code} — ` : ""}${group.name}`;

  return (
    <div
      className={`${styles.chapterRow} ${lit ? styles.chapterRowLit : ""}`}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
    >
      <button
        type="button"
        className={styles.chapterToggle}
        aria-expanded={open}
        onClick={() => {
          onFocus();
          onToggle();
        }}
        title={`${label} — ${summary.executed}/${summary.total} executed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.skipped} skipped`}
      >
        <span className={styles.chapterChevron} aria-hidden="true">
          {open ? <DownOutlined /> : <RightOutlined />}
        </span>
        <span className={styles.chapterName}>{group.name}</span>
        {summary.failed + summary.blocked > 0 && (
          <span className={styles.chapterBadge}>
            {summary.failed + summary.blocked} failed
          </span>
        )}
      </button>

      <span className={styles.chapterProgress}>
        <span
          className={styles.chapterBar}
          role="img"
          aria-label={`${summary.executed} of ${summary.total} executed`}
        >
          {summary.total === 0 ? (
            <span className={styles.groupSegEmpty} />
          ) : (
            <>
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  className={[styles.groupSeg, segment.tone ? styles[segment.tone] : ""].filter(Boolean).join(" ")}
                  style={{ flexGrow: segment.value }}
                  aria-hidden="true"
                />
              ))}
              {summary.notStarted > 0 && (
                <span
                  className={styles.groupSegRest}
                  style={{ flexGrow: summary.notStarted }}
                  aria-hidden="true"
                />
              )}
            </>
          )}
        </span>
        <span className={styles.chapterCaption}>
          {summary.executed}/{summary.total} executed
          {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ""}
        </span>
      </span>
    </div>
  );
}

export default function TestPlanPage({ sessionId }) {
  const confirmPopUp = useConfirmPopUp();
  const [editForm] = Form.useForm();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupOverrides, setGroupOverrides] = useState(() => new Map());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [setupOpen, setSetupOpen] = useState(false);
  /* The chapter the ring is reading out; hover or focus sets it, leaving clears it. */
  const [activeChapter, setActiveChapter] = useState(null);
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
  const activeSelectedIds = useMemo(
    () => activeSelection(selectedIds, plan?.cases ?? []),
    [selectedIds, plan],
  );

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
  const chips = useMemo(() => coverageChips(coverage, FILTERS), [coverage]);

  /**
   * Open when the user opened it; open while a filter is on, so matches are visible; otherwise
   * open only for the categories that already hold a failed or blocked case. A filter never writes
   * an override, so clearing it returns the plan to the calm, collapsed view.
   */
  const isGroupOpen = (group) =>
    groupIsOpen(group, { overrides: groupOverrides, filtersActive, focusCaseId });
  const allExpanded = groups.length > 0 && groups.every(isGroupOpen);

  const { statusMutation, updateCaseMutation, removeCaseMutation, casesRemoveMutation, invalidate } =
    usePlanMutations(sessionId, {
      onCaseUpdated: () => setEditingCase(null),
      onCaseRemoved: (testId) => {
        // Drop the removed id from the selection so the selection bar can't
        // reference a case that is no longer part of the plan.
        setSelectedIds((prev) => {
          if (!prev.has(testId)) return prev;
          const next = new Set(prev);
          next.delete(testId);
          return next;
        });
      },
      onCasesRemoved: () => setSelectedIds(new Set()),
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

  const toggleSelected = (testId) =>
    setSelectedIds((previous) => toggledSelection(previous, testId));

  const setGroupSelected = (testIds, checked) => {
    setSelectedIds((previous) => selectionWith(previous, testIds, checked));
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

  /* The page's actions ride in the app header, on the same row as the
     engagement's breadcrumb, so the body opens on the plan itself instead of a
     band of buttons. Published upward because the header belongs to the session
     layout, one level above this page. */
  const actions = useMemo(
    () => (
      <>
        <Tooltip title="Reload the plan and its coverage">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => planQuery.refetch()}
            aria-label="Reload the plan"
          />
        </Tooltip>
        <Button
          icon={<PlayCircleOutlined />}
          disabled={!plan}
          onClick={() => router.push(`/session/${sessionId}/scans`)}
        >
          Scans
        </Button>
        <Button
          type="primary"
          icon={<SettingOutlined />}
          // Never open setup on a plan we could not read: the modal would start
          // from an empty selection and save over the real one.
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
      </>
    ),
    [sessionId, plan, planQuery.isError, planQuery.isLoading, router],
  );
  usePublishHeaderActions(actions);

  if (planQuery.isLoading) {
    return (
      <PageShell>
        <PageState state="loading" rows={5} />
      </PageShell>
    );
  }

  const target = plan?.target || engagement?.target;
  const scope = plan?.scope || engagement?.scope;

  return (
    <PageShell>
      <header className={styles.header}>
        <div className={styles.headings}>
          <span className={styles.eyebrow}>OWASP WSTG v{catalog?.version ?? "4.2"}</span>
          <h1>Web Application Security Testing</h1>
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
          {/* The plan as a landscape of chapter towers, with the one figure the
              whole shape stands for. Nothing here is said twice: the towers draw
              the outcome chapter by chapter, the readout totals it, and the chips
              below are the control that filters on it. */}
          <section className={styles.outcomes} aria-label="Plan outcomes">
            <div className={styles.outcomeStage}>
              <PlanTerrain
                groups={groups}
                sessionId={sessionId}
                className={styles.terrainCanvas}
                onPick={(group) => {
                  /* Clicking a tower opens its chapter in the table below and
                     takes the reader to its first case. */
                  setActiveChapter(group.key);
                  setGroupOpen([group], true);
                  const first = group.cases[0];
                  if (first) {
                    requestAnimationFrame(() => {
                      document
                        .getElementById(`case-${first.testId}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "center" });
                    });
                  }
                }}
              />
              <div className={styles.terrainReadout}>
                <span className={styles.terrainPercent}>
                  {coverage.total
                    ? Math.round((coverage.executed / coverage.total) * 100)
                    : 0}
                  <span className={styles.terrainPercentMark}>%</span>
                </span>
                <span className={styles.terrainCount}>
                  <b>{coverage.executed}</b>
                  <span>/{coverage.total} cases executed</span>
                </span>
                <span className={styles.terrainHint}>
                  one tower per WSTG chapter, one block per case
                </span>
              </div>
            </div>
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
                  const groupIds = group.matches.map((testCase) => testCase.testId);
                  const groupSelectedCount = groupIds.filter((testId) =>
                    activeSelectedIds.has(testId),
                  ).length;

                  return (
                    <div key={group.key} className={styles.group}>
                      {/* The chapter's own header: its name, the bar that draws
                          its outcome, and the caption that says what the bar
                          counted. The terrain above names the chapters; this is
                          where each one is opened and managed. */}
                      <ChapterRow
                        group={group}
                        lit={activeChapter === group.key}
                        open={open}
                        onToggle={() => toggleGroup(group)}
                        onFocus={() => setActiveChapter(group.key)}
                        onBlur={() => setActiveChapter(null)}
                      />

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
    </PageShell>
  );
}
