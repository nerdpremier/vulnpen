"use client";

import React, { useMemo, useState } from "react";
import { Alert, Input, Modal, Select } from "antd";
import {
  AppstoreOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import { ColumnChart } from "@/components/common/ui";
import {
  isUnrunCase,
  resolveScanSelection,
  scanCasesByCategory,
} from "@/utils/scans.mjs";
import useScanMutations from "@/hooks/useScanMutations";
import styles from "@/styles/pages/TestPlan.module.scss";

/**
 * The New Scan dialog: pick the cases this scan covers, name it, and decide how
 * much approval it may assume — then launch it and walk away. This is the one
 * entry point that replaces "type a prompt and hope".
 *
 * The layout is a single column of one-line option rows — a scope row carries
 * its count on the right, an approval row carries only its dot — stacked under
 * a one-line summary strip. Everything is meant to be read in one pass, with no
 * scrolling, so the fastest path is always "keep the defaults, hit Launch".
 *
 * The component is mounted only while the dialog is open, so its initial state
 * is computed once at open instead of synced by an effect.
 */

/* The three ways to bound a scan. Each row carries the count it would run, so
   the choice is made on numbers, not on labels. */
const SCOPES = [
  {
    value: "not_run",
    label: "Remaining",
    hint: "Cases with no result yet",
    icon: <ClockCircleOutlined />,
  },
  {
    value: "all",
    label: "Whole plan",
    hint: "Re-run every case",
    icon: <AppstoreOutlined />,
  },
  {
    value: "custom",
    label: "Choose cases",
    hint: "Pick from the plan",
    icon: <CheckSquareOutlined />,
  },
];

const POLICIES = [
  {
    value: "unattended",
    label: "Unattended",
    hint: "Auto-clears approval boundaries; destructive actions stay blocked",
  },
  {
    value: "supervised",
    label: "Supervised",
    hint: "Your approval setting decides; the scan waits for you",
  },
];

/** The plan's cases as grouped select options: one group per WSTG category. */
function caseOptions(planCases) {
  const groups = new Map();
  for (const testCase of planCases) {
    const code = testCase.categoryCode || "OTHER";
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push({
      value: testCase.testId,
      label: `${testCase.testId} · ${testCase.title}`,
    });
  }
  return [...groups.entries()].map(([code, options]) => ({ label: code, options }));
}

export default function ScanLauncherModal({
  sessionId,
  plan,
  initialTestIds = [],
  onClose,
  onLaunched,
}) {
  const planCases = useMemo(() => plan?.cases ?? [], [plan]);
  const unrunCount = useMemo(
    () => planCases.filter(isUnrunCase).length,
    [planCases],
  );

  const [name, setName] = useState(
    () => `WSTG scan — ${new Date().toLocaleString()}`,
  );
  // Opened from the plan's selection bar, the launcher starts on exactly those
  // cases: the plan is where cases are chosen, so re-picking them here would be
  // busywork. Otherwise it defaults to what is left to run, falling back to the
  // whole plan when nothing is left — so the dialog never opens on a dead end.
  // The component mounts only while the dialog is open, so this is read once
  // rather than synced by an effect.
  const [mode, setMode] = useState(() => {
    if (initialTestIds.length) return "custom";
    return unrunCount > 0 ? "not_run" : "all";
  });
  const [picked, setPicked] = useState(() => [...initialTestIds]);
  const [policy, setPolicy] = useState("unattended");

  const options = useMemo(() => caseOptions(planCases), [planCases]);
  const testIds = useMemo(
    () => resolveScanSelection(planCases, { mode, testIds: picked }),
    [planCases, mode, picked],
  );

  /* The selection drawn: which WSTG categories this scan is about to touch, and
     how much of each — the same category counts the summary line uses. */
  const selectionByCategory = useMemo(
    () =>
      [...scanCasesByCategory(planCases, testIds).entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key, value]) => ({ key, label: key, value })),
    [planCases, testIds],
  );

  const launch = useScanMutations(sessionId).launch;

  const cannotLaunch = testIds.length === 0 || launch.isLoading;
  const countFor = (scopeValue) =>
    scopeValue === "not_run"
      ? unrunCount
      : scopeValue === "all"
        ? planCases.length
        : picked.length;

  return (
    <Modal
      open
      onCancel={onClose}
      centered
      width={600}
      title={
        <span className={styles.scanTitle}>
          New scan
          <span className={styles.scanSubtitle}>
            Pick what to run, then launch it and walk away
          </span>
        </span>
      }
      okText="Launch scan"
      okButtonProps={{ disabled: cannotLaunch, icon: <PlayCircleOutlined /> }}
      confirmLoading={launch.isLoading}
      onOk={() =>
        launch.mutate({
          testIds,
          label: name.trim(),
          policy,
          onLaunched: (run) => {
            onClose?.();
            onLaunched?.(run);
          },
        })
      }
    >
      <div className={styles.scanLauncher}>
        <label className={styles.scanField}>
          <span className={styles.scanFieldLabel}>Scan name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Juice Shop baseline"
          />
        </label>

        <div className={styles.scanField}>
          <span className={styles.scanFieldLabel}>Cases in this scan</span>
          <div
            className={styles.scanOptions}
            role="radiogroup"
            aria-label="Cases in this scan"
          >
            {SCOPES.map((scope) => {
              const active = mode === scope.value;
              return (
                <button
                  key={scope.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`${styles.scanOption} ${
                    active ? styles.choiceSelected : ""
                  }`}
                  onClick={() => setMode(scope.value)}
                >
                  <span className={styles.scanOptionIcon}>{scope.icon}</span>
                  <span className={styles.scanOptionLabel}>{scope.label}</span>
                  <span className={styles.scanOptionHint}>{scope.hint}</span>
                  <span className={styles.scanOptionCount}>
                    {countFor(scope.value)}
                  </span>
                </button>
              );
            })}
          </div>

          {mode === "custom" && (
            <Select
              className={styles.scanCasePicker}
              classNames={{ popup: { root: styles.statusDropdown } }}
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              placeholder="Search the plan's cases"
              value={picked}
              options={options}
              onChange={setPicked}
            />
          )}
        </div>

        <div className={styles.scanField}>
          <span className={styles.scanFieldLabel}>Approval</span>
          <div
            className={styles.scanOptions}
            role="radiogroup"
            aria-label="Approval"
          >
            {POLICIES.map((option) => {
              const active = policy === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`${styles.scanOption} ${
                    active ? styles.choiceSelected : ""
                  }`}
                  onClick={() => setPolicy(option.value)}
                >
                  <span className={styles.choiceRadio} aria-hidden="true" />
                  <span className={styles.scanOptionLabel}>{option.label}</span>
                  <span className={styles.scanOptionHint}>{option.hint}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.scanFocus}>
          <div className={styles.scanFocusText}>
            <div className={styles.scanFocusHead}>
              <span className={styles.scanFocusCount}>{testIds.length}</span>
              <span className={styles.scanFocusUnit}>
                case{testIds.length === 1 ? "" : "s"} against
              </span>
              <span className={styles.scanFocusTarget}>
                {plan?.target || "the engagement target"}
              </span>
            </div>

            {plan?.scope && (
              <p className={styles.scanFocusScope} title={plan.scope}>
                <span className={styles.scanFocusScopeLabel}>Scope</span>
                <span className={styles.scanFocusScopeText}>{plan.scope}</span>
              </p>
            )}
          </div>

          {selectionByCategory.length > 0 && (
            <div className={styles.scanFocusChart}>
              <span className={styles.scanFocusChartLabel}>
                Cases per category
              </span>
              <ColumnChart
                data={selectionByCategory}
                height={40}
                label={`${testIds.length} cases across ${selectionByCategory.length} WSTG categories`}
              />
            </div>
          )}
        </div>

        {mode === "all" && testIds.length > 0 && (
          <Alert
            type="info"
            showIcon
            message="Every case in the plan is scanned, including ones that already carry a result."
          />
        )}
        {testIds.length === 0 && (
          <Alert
            type="warning"
            showIcon
            message={
              mode === "custom"
                ? "No cases selected — pick at least one case to scan."
                : "Nothing left to scan — every case already carries a result. Switch to Whole plan to re-run them."
            }
          />
        )}
      </div>
    </Modal>
  );
}
