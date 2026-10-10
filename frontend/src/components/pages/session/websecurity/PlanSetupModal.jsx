"use client";

import React, { useMemo, useState } from "react";
import { Alert, App, Form, Input, Modal } from "antd";
import { useMutation } from "react-query";
import { generateTestPlan } from "@/services/websecurity.service";
import { apiErrorMessage } from "@/utils/apiError";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import CaseBoard from "@/components/pages/session/CaseBoard";
import styles from "@/styles/pages/TestPlan.module.scss";

/** Every WSTG case of the catalogue, in catalogue order. */
function allCatalogueIds(catalog) {
  return (catalog?.tests ?? []).map((test) => test.id);
}

/** The catalogue cases a plan already holds, read from its cases. */
function plannedCatalogueIds(plan, catalog) {
  const known = new Set(allCatalogueIds(catalog));
  return (plan?.cases ?? [])
    .map((testCase) => testCase.testId)
    .filter((id) => known.has(id));
}

/** Cases of one category, in catalogue order. */
function categoryTests(catalog, code) {
  return (catalog?.tests ?? []).filter((test) => test.category === code);
}

/** What saving this selection would add, drop, and end up holding. */
function previewPlan(plan, catalog, selected) {
  const catalogueIds = new Set((catalog?.tests ?? []).map((test) => test.id));
  const planned = new Set((plan?.cases ?? []).map((testCase) => testCase.testId));
  const dropped = (plan?.cases ?? []).filter(
    (testCase) => catalogueIds.has(testCase.testId) && !selected.has(testCase.testId),
  );

  return {
    total: selected.size,
    added: [...selected].filter((id) => !planned.has(id)).length,
    dropped: dropped.length,
    droppedWithResults: dropped.filter((testCase) => testCase.status !== "not_started").length,
    handAdded: (plan?.cases ?? []).filter((testCase) => !catalogueIds.has(testCase.testId)).length,
  };
}

/**
 * The one place the plan itself is set up: the engagement it belongs to and the WSTG
 * cases it covers, picked on the same case board the New scan dialog uses. Saving
 * rebuilds the case list from the catalogue, so cases that stay keep their results;
 * the page mounts this per open, so the form starts from the plan as it is now.
 */
export default function PlanSetupModal({
  sessionId,
  plan,
  catalog,
  engagement,
  onClose,
  onSaved,
}) {
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const [form] = Form.useForm();
  const [selected, setSelected] = useState(() =>
    plan ? new Set(plannedCatalogueIds(plan, catalog)) : new Set(allCatalogueIds(catalog)),
  );
  const isNew = !plan;
  const preview = useMemo(
    () => previewPlan(plan, catalog, selected),
    [plan, catalog, selected],
  );

  // The catalogue as the board wants it, each case carrying the result the plan
  // already recorded for it — so keeping a case reads as "and keep its result".
  const groups = useMemo(() => {
    const status = new Map(
      (plan?.cases ?? []).map((testCase) => [testCase.testId, testCase.status]),
    );
    return (catalog?.categories ?? []).map((category) => ({
      code: category.code,
      name: category.name,
      items: categoryTests(catalog, category.code).map((test) => ({
        id: test.id,
        title: test.title,
        status: status.get(test.id),
      })),
    }));
  }, [catalog, plan]);

  const saveMutation = useMutation(generateTestPlan, {
    onSuccess: (data) => {
      const added = data?.added ?? 0;
      const kept = data?.kept ?? 0;
      message.success(
        `Plan saved: ${data?.plan?.cases?.length ?? 0} cases (${added} added, ${kept} kept)`,
      );
      onSaved();
      onClose();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not save the plan")),
  });

  // The backend keeps only the explicit ids whose category is listed, so every category with at
  // least one picked case must go out as a code - not just the fully ticked ones.
  const buildSelection = () => {
    const categories = (catalog?.categories ?? [])
      .filter((category) =>
        categoryTests(catalog, category.code).some((test) => selected.has(test.id)),
      )
      .map((category) => category.code);
    const order = new Map((catalog?.tests ?? []).map((test, index) => [test.id, index]));
    const testIds = [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return { categories, testIds };
  };

  const runSave = (values) => {
    const { categories, testIds } = buildSelection();
    saveMutation.mutate({
      sessionId,
      action: "generate",
      target: values.target?.trim() ?? "",
      scope: values.scope?.trim() ?? "",
      categories,
      testIds,
    });
  };

  const handleFinish = (values) => {
    if (!preview.droppedWithResults) {
      runSave(values);
      return;
    }
    confirmPopUp({
      title: `Drop ${preview.dropped} case${preview.dropped === 1 ? "" : "s"}?`,
      content: `${preview.droppedWithResults} of them carry a recorded result, and that result goes with them. The report draft is built from this plan, so download it first if you need those records.`,
      okText: `Drop ${preview.dropped} and save`,
      onOk: () => runSave(values),
    });
  };

  return (
    <Modal
      open
      onCancel={onClose}
      centered
      title={isNew ? "Set up the test plan" : "Plan setup"}
      width={720}
      okText={isNew ? "Create plan" : "Save plan"}
      okButtonProps={{ disabled: isNew && !selected.size }}
      confirmLoading={saveMutation.isLoading}
      onOk={() => form.submit()}
      // This dialog carries more chrome than the board has room for on a short
      // window, so the body scrolls and the header and footer stay put. The cap
      // leaves the header, footer and padding (about 11rem) plus a little slack.
      styles={{ body: { maxHeight: "calc(100vh - 13rem)", overflowY: "auto" } }}
    >
      <Form
        form={form}
        layout="vertical"
        className={styles.darkControls}
        onFinish={handleFinish}
        initialValues={{
          // A plan saved from here always wins; on first open the values come
          // from what was entered when the session was created.
          target: plan?.target || engagement?.target || "",
          scope: plan?.scope || engagement?.scope || "",
        }}
      >
        <div className={styles.settingsSection}>
          <h4>Engagement</h4>
          <p>What is being tested, and under which restrictions.</p>
          <Form.Item
            label="Target"
            name="target"
            rules={[{ required: true, message: "Enter the target under test" }]}
          >
            <Input placeholder="https://app.example.com" />
          </Form.Item>
          <Form.Item label="Scope (optional)" name="scope">
            <Input placeholder="Storefront, REST API, admin" />
          </Form.Item>
        </div>

        <div className={styles.settingsSection}>
          <h4>Categories</h4>
          <p>
            Tick a category to plan all of its cases, or expand it and pick individual cases.
            Unticking a category or a case drops it from the plan; cases that stay keep the
            results recorded against them.
          </p>

          <CaseBoard groups={groups} selected={selected} onChange={setSelected} />

          <div className={styles.scopePreview}>
            <span>{preview.total} cases in scope</span>
            {preview.added > 0 && (
              <span className={styles.scopeAdded}>+{preview.added} to add</span>
            )}
            {preview.dropped > 0 && (
              <span className={styles.scopeDropped}>-{preview.dropped} to drop</span>
            )}
            {preview.handAdded > 0 && <span>{preview.handAdded} added by the assistant kept</span>}
          </div>

          {/* The same figure as a share of the catalogue: saving this is either
              the whole guide or a slice of it, and that should be visible. */}
          <span
            className={styles.scopeBar}
            role="img"
            aria-label={`${preview.total} of ${catalog?.totalTests ?? 0} catalogue cases planned`}
          >
            <span
              className={styles.scopeBarFill}
              style={{
                width: `${catalog?.totalTests ? Math.min(100, (preview.total / catalog.totalTests) * 100) : 0}%`,
              }}
            />
          </span>

          {preview.droppedWithResults > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${preview.droppedWithResults} of the dropped cases carry a recorded result`}
            />
          )}

          {preview.total === 0 && (
            <Alert
              type="warning"
              showIcon
              message="No case selected - saving leaves the plan without catalogue cases"
            />
          )}

          <p className={styles.scopeHint}>
            Only the ticked categories and cases are planned. Nothing ticked means no catalogue
            cases, and any case the assistant added by hand is always kept.
          </p>
        </div>
      </Form>
    </Modal>
  );
}
