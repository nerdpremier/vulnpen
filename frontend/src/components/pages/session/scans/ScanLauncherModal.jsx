"use client";

import React, { useMemo, useState } from "react";
import { Button, Form, Input, Modal, Switch } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { resolveScanSelection, scanCasesByCategory } from "@/utils/scans.mjs";
import useScanMutations from "@/hooks/useScanMutations";
import CaseBoard from "@/components/pages/session/CaseBoard";
import styles from "@/styles/pages/TestPlan.module.scss";

/**
 * The New scan dialog: name it, bound what it runs, then launch it and walk away.
 *
 * The scope is two pills — Whole plan and Choose cases — each carrying the count it
 * would run, so the bound is read off a number rather than a sentence. "Choose
 * cases" opens the shared case board: one row per WSTG category with its own
 * select-all, a share bar and an expandable list of the cases it holds, each
 * carrying the result it already has.
 *
 * Approval stays in the footer beside the buttons: it is a decision about the run
 * itself, not about its scope. The component is mounted per open, so its initial
 * state is computed once instead of synced by an effect.
 */

/** The plan's cases as the board's groups, in plan order. */
function boardGroups(planCases) {
  const groups = [];
  const at = new Map();
  for (const testCase of planCases) {
    const code = testCase.categoryCode || "OTHER";
    let group = at.get(code);
    if (!group) {
      group = { code, name: testCase.categoryName || "", items: [] };
      at.set(code, group);
      groups.push(group);
    }
    group.items.push({
      id: testCase.testId,
      title: testCase.title,
      status: testCase.status,
    });
  }
  return groups;
}

export default function ScanLauncherModal({
  sessionId,
  plan,
  initialTestIds = [],
  onClose,
  onLaunched,
}) {
  const planCases = useMemo(() => plan?.cases ?? [], [plan]);

  const [form] = Form.useForm();
  const name = Form.useWatch("name", form) ?? "";
  // Opened from the plan's selection bar, the launcher starts on exactly those
  // cases; otherwise it starts on the whole plan.
  const [mode, setMode] = useState(() =>
    initialTestIds.length ? "custom" : "all",
  );
  const [picked, setPicked] = useState(() => new Set(initialTestIds));
  const [supervised, setSupervised] = useState(false);

  const groups = useMemo(() => boardGroups(planCases), [planCases]);
  const testIds = useMemo(
    () => resolveScanSelection(planCases, { mode, testIds: [...picked] }),
    [planCases, mode, picked],
  );

  const launch = useScanMutations(sessionId).launch;

  const named = name.trim().length > 0;
  const cannotLaunch = !named || testIds.length === 0 || launch.isLoading;

  /* The two bounds a scan can be given. Choose shows its count only once something
     is picked, so an empty picker reads as "nothing yet" rather than a bare,
     broken-looking 0. */
  const scopes = [
    { value: "all", label: "Whole plan", count: planCases.length, show: true },
    {
      value: "custom",
      label: "Choose cases",
      count: picked.size,
      show: picked.size > 0,
    },
  ];

  /* What the pills cannot say: the reach of the run and where it lands. */
  const reach = useMemo(() => {
    if (testIds.length === 0) {
      return planCases.length === 0
        ? "This plan holds no cases yet"
        : "No cases selected yet";
    }
    const categories = scanCasesByCategory(planCases, testIds).size;
    return `${testIds.length} cases · ${categories} categor${
      categories === 1 ? "y" : "ies"
    } · ${plan?.target || "the engagement target"}`;
  }, [testIds, planCases, plan]);

  const submit = () =>
    form
      .validateFields()
      .then(({ name: label }) =>
        launch.mutate({
          testIds,
          label: label.trim(),
          policy: supervised ? "supervised" : "unattended",
          onLaunched: (run) => {
            onClose?.();
            onLaunched?.(run);
          },
        }),
      )
      .catch(() => {});

  return (
    <Modal
      open
      onCancel={onClose}
      centered
      width={mode === "custom" ? 700 : 560}
      title={
        <span className={styles.scanTitle}>
          New scan
          <span className={styles.scanSubtitle}>
            Name it, pick what to run, then walk away
          </span>
        </span>
      }
      footer={
        <div className={styles.scanFooter}>
          <label className={styles.scanApproval}>
            <Switch
              size="small"
              checked={supervised}
              onChange={setSupervised}
              aria-label="Wait for my approval"
            />
            <span>Wait for my approval</span>
          </label>
          <div className={styles.scanActions}>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={launch.isLoading}
              disabled={cannotLaunch}
              onClick={submit}
            >
              Launch scan
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.scanLauncher}>
        <Form
          form={form}
          layout="vertical"
          requiredMark
          className={styles.scanName}
        >
          <Form.Item
            name="name"
            label="Scan name"
            rules={[{ required: true, message: "Name is required" }]}
          >
            <Input placeholder="e.g. Juice Shop baseline" />
          </Form.Item>
        </Form>

        <div className={styles.scanScopeField}>
          <span className={styles.scanFieldLabel}>Cases in this scan</span>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label="Cases in this scan"
          >
            {scopes.map((scope) => {
              const active = mode === scope.value;
              return (
                <button
                  key={scope.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`${styles.chip} ${active ? styles.chipActive : ""}`}
                  onClick={() => setMode(scope.value)}
                >
                  {scope.label}
                  {scope.show && <b>{scope.count}</b>}
                </button>
              );
            })}
          </div>
        </div>

        {mode === "custom" && (
          <CaseBoard
            className={styles.scanBoard}
            groups={groups}
            selected={picked}
            onChange={setPicked}
          />
        )}

        <p className={styles.scanReach}>{reach}</p>
      </div>
    </Modal>
  );
}
