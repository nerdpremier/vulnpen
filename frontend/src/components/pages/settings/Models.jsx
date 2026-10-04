"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Tag,
  Tooltip,
} from "antd";
import {
  ApiOutlined,
  BulbOutlined,
  CheckOutlined,
  CloseOutlined,
  CrownFilled,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,

  PlusOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import PrimaryButton from "@/components/common/PrimaryButton";
import Loader from "@/components/common/loader/Loader";
import styles from "@/styles/pages/Settings.module.scss";
import { useMutation, useQuery, useQueryClient } from "react-query";
import {
  getAvailableModels,
  getModels,
  updateModels,
} from "@/services/user.service";
import {
  getMagnitudeModelIssue,
  isMagnitudeModelCompatible,
} from "@/utils/magnitudeModels";

const PROVIDER_OPTIONS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama (Local)" },
  { value: "openai-compatible", label: "OpenAI-Compatible" },
];

const REASONING_OPTIONS = ["off", "low", "medium", "high", "xhigh", "max"].map(
  (value) => ({ value, label: value.toUpperCase() }),
);

const PROVIDER_META = {
  openrouter: {
    keyURL: "https://openrouter.ai/settings/keys",
    keyLabel: "Get OpenRouter API Key",
  },
  ollama: {
    keyURL: "https://ollama.com/library",
    keyLabel: "Browse Ollama models",
  },
};

const FALLBACK_MODELS = {
  openrouter: [
    "moonshotai/kimi-k3",
    "anthropic/claude-opus-5",
    "openai/gpt-5.6-sol",
    "minimax/minimax-m2.7",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.5",
  ],
  ollama: ["llama3.3", "llama3.2", "qwen2.5-coder", "mistral"],
};

const EMPTY_MODEL = {
  label: "",
  provider: "openrouter",
  model: "",
  apiKey: "",
  baseURL: "",
  reasoningMode: "off",
};

const NONE_MODEL_VALUE = "__none__";

function createModelId(label) {
  const suffix =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : String(Date.now()).slice(-8);
  const slug =
    label
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "model";
  return `${slug}-${suffix}`;
}

function needsBaseURL(provider) {
  return ["openai-compatible", "ollama"].includes(provider);
}

function baseURLPlaceholder(provider) {
  if (provider === "ollama") return "Docker host: http://host.docker.internal:11434/v1";
  return "https://api.groq.com/openai/v1";
}

function providerLabel(provider) {
  return (
    PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ||
    provider
  );
}

function assignedIds(assignments) {
  return new Set(
    [
      assignments?.orchestratorModelId,
      assignments?.browserModelId,
    ].filter(Boolean),
  );
}

const ModelModal = ({
  open,
  initialValues,
  modelSuggestions,
  saving,
  onCancel,
  onSubmit,
}) => {
  const [form] = Form.useForm();
  const provider = Form.useWatch("provider", form) || initialValues.provider;
  const providerMeta = PROVIDER_META[provider] || {};
  const browserModelIssue = getMagnitudeModelIssue({
    provider,
    baseURL: Form.useWatch("baseURL", form) || initialValues.baseURL,
  });

  return (
    <Modal
      title={initialValues.id ? "Edit Model" : "Add Model"}
      open={open}
      onCancel={onCancel}
      footer={null}
      width={720}
      centered
      className={styles.modelModal}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={initialValues}
        onFinish={(values) => {
          const entry = {
            ...initialValues,
            ...values,
            id: initialValues.id || createModelId(values.label),
          };
          if (!entry.apiKey) delete entry.apiKey;
          if (!entry.baseURL) delete entry.baseURL;
          onSubmit(entry);
        }}
      >
        <Row gutter={14}>
          <Col span={8}>
            <Form.Item
              label="Label"
              name="label"
              rules={[{ required: true, message: "Label is required" }]}
            >
              <Input placeholder="e.g. Claude Sonnet" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="Provider"
              name="provider"
              rules={[{ required: true }]}
            >
              <Select
                options={PROVIDER_OPTIONS}
                popupMatchSelectWidth={false}
                classNames={{ popup: { root: styles.modelSelectDropdown } }}
                onChange={(value) => {
                  // Re-clear the provider-specific fields only when the
                  // provider actually changed, in one store update.
                  if (value !== initialValues.provider) {
                    form.setFieldsValue({ model: "", baseURL: "" });
                  }
                }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="Model"
              name="model"
              rules={[{ required: true, message: "Model is required" }]}
            >
              <AutoComplete
                allowClear
                placeholder="Select or type a model"
                classNames={{ popup: { root: styles.modelSelectDropdown } }}
                options={(modelSuggestions[provider] || []).map((model) => ({
                  value: model,
                  label: model,
                }))}
                filterOption={(input, option) =>
                  option.value.toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={14}>
          <Col
            span={needsBaseURL(provider) ? 8 : 12}
          >
            <Form.Item label="Reasoning" name="reasoningMode">
              <Select
                options={REASONING_OPTIONS}
                classNames={{ popup: { root: styles.modelSelectDropdown } }}
              />
            </Form.Item>
          </Col>
          <Col span={needsBaseURL(provider) ? 8 : 12}>
            <Form.Item label="API Key" name="apiKey">
              <Input.Password
                autoComplete="off"
                placeholder={
                  provider === "ollama"
                    ? "Optional for local Ollama"
                    : "API key"
                }
              />
            </Form.Item>
          </Col>
          {needsBaseURL(provider) && (
            <Col span={8}>
              <Form.Item
                label="Base URL"
                name="baseURL"
                rules={[
                  {
                    // Optional for Ollama (local default endpoint).
                    required: provider !== "ollama",
                    message: "Base URL is required",
                  },
                ]}
              >
                <Input placeholder={baseURLPlaceholder(provider)} />
              </Form.Item>
            </Col>
          )}
        </Row>

        {browserModelIssue && (
          <div className={styles.warningBox} style={{ marginBottom: "1rem" }}>
            <WarningOutlined />
            <span>
              This preset can still be used for the orchestrator, but it
              will not appear in the Browser Agent selector.{" "}
              {browserModelIssue}
            </span>
          </div>
        )}

        <Row justify="space-between" align="middle">
          <Col>
            {providerMeta.keyURL && (
              <a
                href={providerMeta.keyURL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalLink}
              >
                <ExportOutlined style={{ fontSize: 11 }} />
                {providerMeta.keyLabel}
              </a>
            )}
          </Col>
          <Col>
            <div style={{ display: "flex", gap: 8 }}>
              <PrimaryButton
                onClick={onCancel}
                style={{ height: 32, fontSize: "0.75rem" }}
              >
                <CloseOutlined /> Cancel
              </PrimaryButton>
              <PrimaryButton
                purpleFilled
                htmlType="submit"
                loading={saving}
                style={{ height: 32, fontSize: "0.75rem" }}
              >
                <CheckOutlined /> Test &amp; Save
              </PrimaryButton>
            </div>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
};

const ModelsPage = () => {
  const { message, notification } = App.useApp();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery(
    "unified-models",
    getModels,
    { retryOnMount: false },
  );
  const { data: catalog } = useQuery("available-models", getAvailableModels, {
    staleTime: 6 * 60 * 60 * 1000,
    cacheTime: 6 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const [editingModel, setEditingModel] = useState(null);

  const models = data?.models || [];
  const assignments = data?.assignments || {};
  const protectedIds = assignedIds(assignments);

  const modelSuggestions = useMemo(() => {
    const suggestions = { ...FALLBACK_MODELS };
    if (catalog?.providers) {
      for (const provider of catalog.providers) {
        const existing = new Set(suggestions[provider.id] || []);
        suggestions[provider.id] = [...existing];
        for (const catalogModel of provider.models) {
          const modelId =
            provider.id === "anthropic"
              ? catalogModel.modelId.replace(/(\d+)\.(\d+)/g, "$1-$2")
              : catalogModel.modelId;
          if (!existing.has(modelId)) {
            existing.add(modelId);
            suggestions[provider.id].push(modelId);
          }
        }
      }
    }
    return suggestions;
  }, [catalog]);

  const persistMutation = useMutation(updateModels, {
    onSuccess: () => {
      message.success("Models updated");
      queryClient.invalidateQueries("unified-models");
      queryClient.invalidateQueries("magnitude-config");
    },
    onError: (err) => {
      notification.error({
        message: "Error",
        description: err?.response?.data?.message ?? "Failed to update models",
      });
    },
  });



  const persist = (nextModels, nextAssignments = assignments) => {
    persistMutation.mutate({
      models: nextModels,
      assignments: nextAssignments,
    });
  };

  if (isLoading) return <Loader />;

  if (isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Could not load model settings"
        description="The backend did not return the model registry. Retry after checking the backend connection."
        action={<Button onClick={() => refetch()}>Retry</Button>}
      />
    );
  }

  const options = models.map((model) => ({
    value: model.id,
    label: `${model.label} · ${model.model}`,
  }));
  const browserModelOptions = models
    .filter(isMagnitudeModelCompatible)
    .map((model) => ({
      value: model.id,
      label: `${model.label} · ${model.model}`,
    }));
  const optionalModelOptions = [
    { value: NONE_MODEL_VALUE, label: "None" },
    ...browserModelOptions,
  ];
  const selectedBrowserModel = models.find(
    (model) => model.id === assignments.browserModelId,
  );
  const browserModelIssue =
    selectedBrowserModel && getMagnitudeModelIssue(selectedBrowserModel);

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.settingSectionHeader}>
        <div className={styles.settingSectionHeaderRow}>
          <div className={styles.heading}>Assignments</div>
          <PrimaryButton
            purple
            onClick={() => setEditingModel({ ...EMPTY_MODEL })}
            style={{ height: 30, fontSize: "0.72rem" }}
          >
            <PlusOutlined /> Add Model
          </PrimaryButton>
        </div>
        <div className={styles.divider} />
      </div>

      <Form layout="vertical" requiredMark={false}>
        <Form.Item label="Orchestrator">
          <Select
            allowClear
            placeholder="Select orchestrator model"
            value={assignments.orchestratorModelId}
            options={options}
            onChange={(value) =>
              persist(models, {
                ...assignments,
                orchestratorModelId: value,
              })
            }
          />
        </Form.Item>

        <Form.Item label="Browser Agent">
          <Select
            placeholder="Select browser model"
            value={browserModelIssue ? NONE_MODEL_VALUE : assignments.browserModelId}
            options={optionalModelOptions}
            onChange={(value) =>
              persist(models, {
                ...assignments,
                browserModelId:
                  value === NONE_MODEL_VALUE ? undefined : value,
              })
            }
          />
        </Form.Item>

        {browserModelIssue && (
          <div className={styles.errorBox} style={{ marginTop: "-0.5rem" }}>
            <WarningOutlined />
            <span>
              The currently assigned Browser Agent model is incompatible and is
              hidden from the selector. Choose a compatible preset or set
              Browser Agent to None. {browserModelIssue}
            </span>
          </div>
        )}
      </Form>

      <div className={styles.settingSectionHeader}>
        <div className={styles.heading}>Configured Models</div>
        <div className={styles.divider} />
      </div>

      {models.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No models configured"
          style={{ margin: "24px 0" }}
        />
      ) : (
        <div className={styles.settingsList}>
          {models.map((model) => {
            const isAssigned = protectedIds.has(model.id);
            return (
              <div key={model.id} className={styles.settingsListItem}>
                <div className={styles.settingsListItemHeader}>
                  <div className={styles.settingsListItemTitle}>
                    <ApiOutlined />
                    {model.label}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {assignments.orchestratorModelId === model.id && (
                      <Tag color="purple">
                        <CrownFilled /> Orchestrator
                      </Tag>
                    )}
                    {assignments.browserModelId === model.id && (
                      <Tag color="blue">Browser</Tag>
                    )}
                  </div>
                </div>
                <div className={styles.settingsListItemMeta}>
                  {providerLabel(model.provider)} · {model.model} · Reasoning{" "}
                  {(model.reasoningMode || "off").toUpperCase()}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {model.apiKey && <Tag>KEY</Tag>}
                  {model.baseURL && <Tag>URL</Tag>}
                  <Tag color={model.verifiedAt ? "green" : "warning"}>
                    {model.verifiedAt ? "VERIFIED" : "UNVERIFIED"}
                  </Tag>
                  {isMagnitudeModelCompatible(model) ? (
                    <Tag color="green">BROWSER OK</Tag>
                  ) : (
                    <Tooltip title={getMagnitudeModelIssue(model)}>
                      <Tag color="warning">NO BROWSER</Tag>
                    </Tooltip>
                  )}
                  <Tag>
                    <BulbOutlined />{" "}
                    {(model.reasoningMode || "off").toUpperCase()}
                  </Tag>
                  <span style={{ flex: 1 }} />
                  <Tooltip title="Edit model">
                    <EditOutlined
                      onClick={() => setEditingModel(model)}
                      style={{
                        color: "var(--secondary-text)",
                        cursor: "pointer",
                      }}
                    />
                  </Tooltip>
                  <Popconfirm
                    title={
                      isAssigned
                        ? "Clear assignments before deleting this model."
                        : "Delete this model?"
                    }
                    onConfirm={() =>
                      !isAssigned &&
                      persist(models.filter((entry) => entry.id !== model.id))
                    }
                    okText="Delete"
                    cancelText="Cancel"
                  >
                    <DeleteOutlined
                      style={{
                        color: isAssigned
                          ? "var(--secondary-text-500)"
                          : "var(--secondary-text)",
                        cursor: isAssigned ? "not-allowed" : "pointer",
                      }}
                    />
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ModelModal
        open={!!editingModel}
        initialValues={editingModel || EMPTY_MODEL}
        modelSuggestions={modelSuggestions}
        saving={persistMutation.isLoading}
        onCancel={() => setEditingModel(null)}
        onSubmit={(entry) => {
          const exists = models.some((model) => model.id === entry.id);
          persistMutation.mutate(
            {
              models: exists
              ? models.map((model) => (model.id === entry.id ? entry : model))
              : [...models, entry],
              assignments,
            },
            { onSuccess: () => setEditingModel(null) },
          );
        }}
      />

    </div>
  );
};

export default ModelsPage;
