// Pure model-config helpers shared by the Models settings page. Extracted from
// Models.jsx so the provider rules are unit-testable without mounting React.

export const PROVIDER_OPTIONS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama (Local)" },
  { value: "openai-compatible", label: "OpenAI-Compatible" },
];

export function createModelId(label) {
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

export function needsBaseURL(provider) {
  return ["openai-compatible", "ollama"].includes(provider);
}

export function baseURLPlaceholder(provider) {
  if (provider === "ollama") return "Docker host: http://host.docker.internal:11434/v1";
  return "https://api.groq.com/openai/v1";
}

export function providerLabel(provider) {
  return (
    PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ||
    provider
  );
}

export function assignedIds(assignments) {
  return new Set(
    [
      assignments?.orchestratorModelId,
      assignments?.browserModelId,
    ].filter(Boolean),
  );
}
