"use client";

import React, { useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, Form, Input, Modal } from "antd";
import { useMutation } from "react-query";
import { generateTestPlan } from "@/services/websecurity.service";
import { apiErrorMessage } from "@/utils/apiError";
import styles from "@/styles/pages/TestPlan.module.scss";

/** Every WSTG category code, in catalogue order. */
function allCategoryCodes(catalog) {
  return (catalog?.categories ?? []).map((category) => category.code);
}

/** The categories a plan already covers, read from its cases. */
function plannedCategories(plan, catalog) {
  const known = new Set(allCategoryCodes(catalog));
  return Array.from(new Set((plan?.cases ?? []).map((testCase) => testCase.categoryCode))).filter(
    (code) => known.has(code),
  );
}

/** What saving this category selection would add, drop, and end up holding. */
function previewPlan(plan, catalog, selected) {
  const catalogueTests = catalog?.tests ?? [];
  const codes = new Set(selected);
  // Only the ticked categories are planned: ticking nothing plans nothing.
  const scopeIds = catalogueTests
    .filter((test) => codes.has(test.category))
    .map((test) => test.id);

  const inScope = new Set(scopeIds);
  const catalogueIds = new Set(catalogueTests.map((test) => test.id));
  const planned = new Set((plan?.cases ?? []).map((testCase) => testCase.testId));
  const dropped = (plan?.cases ?? []).filter(
    (testCase) => catalogueIds.has(testCase.testId) && !inScope.has(testCase.testId),
  );

  return {
    total: scopeIds.length,
    added: scopeIds.filter((testId) => !planned.has(testId)).length,
    dropped: dropped.length,
    droppedWithResults: dropped.filter((testCase) => testCase.status !== "not_started").length,
    handAdded: (plan?.cases ?? []).filter((testCase) => !catalogueIds.has(testCase.testId)).length,
  };
}

/**
 * The one place the plan itself is set up: the engagement it belongs to and the WSTG categories it
 * covers. Saving rebuilds the case list from the catalogue, so cases that stay keep their results;
 * the page mounts this per open, so the form starts from the plan as it is now.
 */
export default function PlanSetupModal({ sessionId, plan, catalog, onClose, onSaved }) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [categories, setCategories] = useState(() =>
    plan ? plannedCategories(plan, catalog) : allCategoryCodes(catalog),
  );
  const isNew = !plan;
  const preview = useMemo(
    () => previewPlan(plan, catalog, categories),
    [plan, catalog, categories],
  );

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

  const runSave = (values) => {
    saveMutation.mutate({
      sessionId,
      action: "generate",
      target: values.target?.trim() ?? "",
      scope: values.scope?.trim() ?? "",
      notes: values.notes?.trim() ?? "",
      categories,
    });
  };

  const handleFinish = (values) => {
    if (!preview.droppedWithResults) {
      runSave(values);
      return;
    }
    modal.confirm({
      title: `Drop ${preview.dropped} case${preview.dropped === 1 ? "" : "s"}?`,
      content: `${preview.droppedWithResults} of them carry a recorded result, and that result goes with them. The report draft is built from this plan, so download it first if you need those records.`,
      okText: `Drop ${preview.dropped} and save`,
      okButtonProps: { danger: true },
      onOk: () => runSave(values),
    });
  };
  return (
    <Modal
      open
      onCancel={onClose}
      title={isNew ? "Set up the test plan" : "Plan setup"}
      width={720}
      okText={isNew ? "Create plan" : "Save plan"}
      okButtonProps={{ disabled: isNew && !categories.length }}
      confirmLoading={saveMutation.isLoading}
      onOk={() => form.submit()}
    >
      <Form
        form={form}
        layout="vertical"
        className={styles.darkControls}
        onFinish={handleFinish}
        initialValues={{
          target: plan?.target ?? "",
          scope: plan?.scope ?? "",
          notes: plan?.notes ?? "",
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
          <div className={styles.twoUp}>
            <Form.Item label="Scope (optional)" name="scope">
              <Input placeholder="Storefront, REST API, admin" />
            </Form.Item>
            <Form.Item label="Notes (optional)" name="notes">
              <Input placeholder="Out of scope items, credentials, test windows" />
            </Form.Item>
          </div>
        </div>

        <div className={styles.settingsSection}>
          <div className={styles.sectionHead}>
            <h4>Categories</h4>
            <div className={styles.sectionActions}>
              <Button
                size="small"
                type="link"
                onClick={() => setCategories(allCategoryCodes(catalog))}
              >
                Select all
              </Button>
              <Button size="small" type="link" onClick={() => setCategories([])}>
                Clear
              </Button>
            </div>
          </div>
          <p>
            The plan holds every WSTG case in the categories you tick, and drops the cases of the ones
            you untick. Cases that stay keep the results recorded against them.
          </p>
          <Checkbox.Group
            value={categories}
            onChange={setCategories}
            className={styles.categoryPicker}
          >
            {(catalog?.categories ?? []).map((category) => (
              <Checkbox key={category.code} value={category.code}>
                <span className={styles.categoryText}>
                  <span className={styles.categoryName}>
                    {category.section} {category.name}
                  </span>
                  <span className={styles.categoryMeta}>{category.testCount} cases</span>
                </span>
              </Checkbox>
            ))}
          </Checkbox.Group>

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
              message="No category ticked - saving leaves the plan without catalogue cases"
            />
          )}

          <p className={styles.scopeHint}>
            Only the ticked categories are planned. Nothing ticked means no catalogue cases, and any
            case the assistant added by hand is always kept.
          </p>
        </div>
      </Form>
    </Modal>
  );
}