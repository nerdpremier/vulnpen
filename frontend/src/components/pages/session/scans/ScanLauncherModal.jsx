"use client";

import React, { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "react-query";
import { Alert, App, Button, Input, Modal, Radio, Select } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { launchScan } from "@/services/websecurity.service";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { ColumnChart } from "@/components/common/ui";
import { apiErrorMessage } from "@/utils/apiError";
import { resolveScanSelection } from "@/utils/scans.mjs";
import styles from "@/styles/pages/TestPlan.module.scss";
import detail from "@/styles/pages/ScanDetail.module.scss";

/**
 * The New Scan dialog: pick the cases this scan covers, name it, and decide how
 * much approval it may assume — then launch it and walk away. This is the one
 * entry point that replaces "type a prompt and hope".
 *
 * The component is mounted only while the dialog is open, so its initial state
 * is computed once at open instead of synced by an effect.
 */

const SCOPES = [
  { value: "not_run", label: "Not executed" },
  { value: "all", label: "Whole plan" },
  { value: "custom", label: "Pick cases" },
];

const POLICIES = [
  {
    value: "unattended",
    label: "Unattended",
    hint: "The Approve-for-me reviewer clears approval boundaries. Destructive actions against the target stay blocked.",
  },
  {
    value: "supervised",
    label: "Supervised",
    hint: "Your own approval setting decides; the scan parks on the scan page and waits for you.",
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
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const planCases = useMemo(() => plan?.cases ?? [], [plan]);

  const [name, setName] = useState(
    () => `WSTG scan — ${new Date().toLocaleString()}`,
  );
  // Opened from the plan's selection bar, the launcher starts on exactly those
  // cases: the plan is where cases are chosen, so re-picking them here would be
  // busywork. The component mounts only while the dialog is open, so this is
  // read once rather than synced by an effect.
  const [mode, setMode] = useState(() =>
    initialTestIds.length ? "custom" : "not_run",
  );
  const [picked, setPicked] = useState(() => [...initialTestIds]);
  const [policy, setPolicy] = useState("unattended");

  const options = useMemo(() => caseOptions(planCases), [planCases]);
  const testIds = useMemo(
    () => resolveScanSelection(planCases, { mode, testIds: picked }),
    [planCases, mode, picked],
  );

  /* The selection drawn: which WSTG categories this scan is about to touch, and
     how much of each. The sentence above it stays for the exact count. */
  const selectionByCategory = useMemo(() => {
    const pickedIds = new Set(testIds);
    const map = new Map();
    for (const testCase of planCases) {
      if (!pickedIds.has(testCase.testId)) continue;
      const key = testCase.categoryCode || "OTHER";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, value]) => ({ key, label: key, value }));
  }, [planCases, testIds]);

  const launch = useMutation(launchScan, {
    onSuccess: (data) => {
      message.success(
        data.position > 1
          ? `Scan queued — position ${data.position}`
          : "Scan launched — results land here as the agent works",
      );
      queryClient.invalidateQueries(["scans", sessionId]);
      // The scan writes its own transcript channel; the chat page reloads its
      // stale store the next time it is opened.
      useAgentStreamStore.getState().markHistoryStale?.(sessionId);
      onLaunched?.(data.run);
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not launch the scan")),
  });

  const cannotLaunch = testIds.length === 0 || launch.isLoading;

  return (
    <Modal
      open
      onCancel={onClose}
      title="New scan"
      width={620}
      okText="Launch scan"
      okButtonProps={{ disabled: cannotLaunch, icon: <PlayCircleOutlined /> }}
      confirmLoading={launch.isLoading}
      onOk={() => launch.mutate({ sessionId, testIds, label: name.trim(), policy })}
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
          <Radio.Group
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            {SCOPES.map((scope) => (
              <Radio.Button key={scope.value} value={scope.value}>
                {scope.label}
              </Radio.Button>
            ))}
          </Radio.Group>

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

          <p className={styles.scanFieldHint}>
            {testIds.length} case{testIds.length === 1 ? "" : "s"} will run against{" "}
            <strong>{plan?.target || "the engagement target"}</strong>
            {plan?.scope ? ` — scope: ${plan.scope}` : ""}.
          </p>

          {selectionByCategory.length > 0 && (
            <div className={detail.launchChart}>
              <span className={detail.launchChartLabel}>
                Cases per category
              </span>
              <ColumnChart
                data={selectionByCategory}
                height={72}
                label={`${testIds.length} cases across ${selectionByCategory.length} WSTG categories`}
              />
            </div>
          )}
        </div>

        <div className={styles.scanField}>
          <span className={styles.scanFieldLabel}>Approval</span>
          <Radio.Group
            value={policy}
            onChange={(event) => setPolicy(event.target.value)}
            className={styles.policyChoices}
          >
            {POLICIES.map((option) => (
              <Radio key={option.value} value={option.value}>
                <span className={styles.policyTitle}>{option.label}</span>
                <span className={styles.policyHint}>{option.hint}</span>
              </Radio>
            ))}
          </Radio.Group>
        </div>

        {mode === "all" && (
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
            message="Nothing to scan — every case in the plan already carries a result."
          />
        )}
      </div>
    </Modal>
  );
}
