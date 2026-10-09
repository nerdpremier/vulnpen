import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { observeOpenAI } from "@langfuse/openai";
import { isTracingEnabled } from "../tracing";
import { buildAnthropicMessageParams } from "./anthropicParams";
import {
  invokeSubscriptionInference,
  isSubscriptionProvider,
} from "../../services/subscription-inference.service";
import {
  buildAnthropicClient,
  buildClient,
  isAnthropicApiProvider,
} from "./provider-config";
import { resolveInvocationProvider } from "./orchestrator";
import { toolCallArguments } from "../toolArguments";
import type {
  FinishReason,
  InvokeOptions,
  InvokeResult,
  ProviderConfig,
  ReasoningMode,
  ToolCallData,
} from "./types";

// ─── invoke_llm — non-streaming (kept for summarization, simple calls) ───
// Also the home of the request/response plumbing both invocation paths
// share — the finish-reason vocabulary, the completion-config builder, the
// temperature rules, the logging pair, and the traced client. The streaming
// module imports these; they are an internal seam, not for callers.

function maskSecret(s: string | undefined): string {
  if (!s) return "(empty)";
  if (s.length <= 8) return "****";
  return s.slice(0, 6) + "…" + s.slice(-4);
}

const FIXED_TEMPERATURE_MODELS = new Set(["gpt-5-nano"]);

export function clampTemperature(model: string, requested: number): number {
  for (const m of FIXED_TEMPERATURE_MODELS) {
    if (model.includes(m)) return 1;
  }
  return requested;
}

export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  if (raw === "stop" || raw === "end_turn") return "stop";
  if (raw === "tool_calls" || raw === "tool_use") return "tool_calls";
  if (raw === "length" || raw === "max_tokens") return "length";
  if (raw === "content_filter") return "content_filter";
  return "stop";
}

/**
 * OpenRouter (and similar gateways) can answer 200 with an error body that has
 * no `choices` — e.g. `{ error: { code: 502, message: "Provider returned an
 * empty response" } }` when the model's upstream is down. Surface that as a
 * readable error instead of a TypeError on `choices[0]`.
 */
export function assertCompletionChoices(
  response: OpenAI.Chat.ChatCompletion | undefined,
): void {
  if (response?.choices?.length) return;
  const upstream = (response as any)?.error;
  const detail = upstream?.message || upstream?.code;
  throw new Error(
    detail
      ? `The model provider returned an error instead of a completion: ${detail}. The upstream model may be down — try again or pick another model.`
      : "The model provider returned a response with no completions. The upstream model may be down — try again or pick another model.",
  );
}

function extractToolCalls(
  message: OpenAI.Chat.ChatCompletionMessage,
): ToolCallData[] {
  if (!message.tool_calls?.length) return [];
  return message.tool_calls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    // Some providers omit `arguments` entirely for a no-argument call; an
    // empty string would fail the session schema's required path.
    arguments: toolCallArguments(tc.function.arguments),
  }));
}

export function logRequest(
  config: ProviderConfig,
  opts: InvokeOptions,
  streaming: boolean,
) {
  const msgCount = opts.messages.length;
  const lastRole = opts.messages[msgCount - 1]?.role ?? "?";
  const totalChars = opts.messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    return n;
  }, 0);

  console.log(
    `[inference] → provider=${config.provider} model=${config.model} auth=${config.authMethod ?? "api_key"}` +
      ` key=${maskSecret(config.authMethod === "oauth" ? config.oauthAccessToken : config.authMethod === "subscription" ? undefined : config.apiKey)}` +
      ` baseURL=${config.baseURL ?? "(default)"}` +
      ` | msgs=${msgCount} lastRole=${lastRole} chars=${totalChars}` +
      ` tools=${opts.tools?.length ?? 0} stream=${streaming}` +
      ` fmt=${opts.format ?? "text"}`,
  );
}

export function logResponse(
  config: ProviderConfig,
  elapsed: number,
  result: InvokeResult,
) {
  console.log(
    `[inference] ← ${elapsed}ms provider=${config.provider} model=${result.model}` +
      ` tokens=${result.usage?.prompt_tokens ?? "?"}→${result.usage?.completion_tokens ?? "?"}` +
      ` (total ${result.usage?.total_tokens ?? "?"})` +
      ` | finish=${result.finishReason} toolCalls=${result.toolCalls.length}` +
      ` content=${result.content ? result.content.length + " chars" : "null"}`,
  );
}

export function kimiReasoningEffort(mode: ReasoningMode): "low" | "high" | "max" {
  return mode === "low" ? "low" : mode === "max" ? "max" : "high";
}

export function isTemperatureUnsupportedError(err: any, requestedTemp: number): boolean {
  return (
    err?.code === "unsupported_value" &&
    err?.param === "temperature" &&
    requestedTemp !== 1
  );
}

export function buildCompletionConfig(
  config: ProviderConfig,
  opts: InvokeOptions & { abortSignal?: AbortSignal },
  temperature: number,
  stream: boolean,
): any {
  const params: any = {
    model: config.model,
    messages: opts.messages,
    temperature,
    stream,
  };

  if (stream) {
    params.stream_options = { include_usage: true };
  }

  if (opts.tools?.length) {
    params.tools = opts.tools;
    params.tool_choice = "auto";
  }

  if (opts.reasoningMode && opts.reasoningMode !== "off") {
    if (config.provider === "kimi") {
      params.reasoning_effort = kimiReasoningEffort(opts.reasoningMode);
    } else if (config.provider === "openai") {
      params.reasoning_effort = opts.reasoningMode;
    }
  }

  if (
    opts.format === "json" &&
    !opts.tools?.length &&
    config.provider !== "anthropic"
  ) {
    params.response_format = { type: "json_object" };
  }

  return params;
}

function anthropicBlocksToResult(
  response: Anthropic.Message,
  config: ProviderConfig,
  elapsed: number,
): InvokeResult {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCallData[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      contentParts.push(block.text);
    } else if (block.type === "thinking") {
      reasoningParts.push(block.thinking);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  return {
    content: contentParts.join("") || null,
    reasoning: reasoningParts.join("") || null,
    toolCalls,
    finishReason: normalizeFinishReason(response.stop_reason),
    usage: response.usage
      ? {
          prompt_tokens: response.usage.input_tokens ?? 0,
          completion_tokens: response.usage.output_tokens ?? 0,
          total_tokens:
            (response.usage.input_tokens ?? 0) +
            (response.usage.output_tokens ?? 0),
        }
      : undefined,
    model: response.model ?? config.model,
    provider: config.provider,
    elapsedMs: elapsed,
  };
}

async function runAnthropicMessage(
  config: ProviderConfig,
  opts: InvokeOptions,
  start: number,
): Promise<InvokeResult> {
  const client = buildAnthropicClient(config);

  const response = await client.messages.create(
    buildAnthropicMessageParams({
      model: config.model,
      messages: opts.messages,
      tools: opts.tools,
      reasoningMode: opts.reasoningMode,
      enablePromptCache: true,
    }),
  );

  const elapsed = Date.now() - start;
  const result = anthropicBlocksToResult(response, config, elapsed);
  logResponse(config, elapsed, result);
  return result;
}

export function getClient(config: ProviderConfig, opts: InvokeOptions): OpenAI {
  const rawClient = buildClient(config);
  if (isTracingEnabled()) {
    return observeOpenAI(rawClient, {
      sessionId: opts.sessionId,
      userId: opts.userId,
      tags: opts.tags,
      generationName: opts.generationName,
    });
  }
  return rawClient;
}

export async function invoke_llm(opts: InvokeOptions): Promise<InvokeResult> {
  const config = await resolveInvocationProvider(opts);
  const requestedTemp = clampTemperature(
    config.model,
    opts.temperature ?? 0.75,
  );
  const start = Date.now();

  logRequest(config, opts, false);

  if (isSubscriptionProvider(config.provider)) {
    const result = await invokeSubscriptionInference({
      provider: config.provider,
      model: config.model,
      reasoningMode: opts.reasoningMode ?? "off",
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
    });
    const mapped: InvokeResult = {
      ...result,
      usage: result.usage,
      provider: config.provider,
      elapsedMs: Date.now() - start,
    };
    logResponse(config, mapped.elapsedMs, mapped);
    return mapped;
  }

  if (isAnthropicApiProvider(config.provider)) {
    return await runAnthropicMessage(config, opts, start);
  }

  const client = getClient(config, opts);

  const tryCompletion = async (temp: number): Promise<InvokeResult> => {
    const params = buildCompletionConfig(config, opts, temp, false);
    const response = (await client.chat.completions.create(
      params,
    )) as OpenAI.Chat.ChatCompletion;
    assertCompletionChoices(response);
    const elapsed = Date.now() - start;
    const message = response.choices[0]?.message;

    const result: InvokeResult = {
      content: message?.content ?? null,
      reasoning: null,
      toolCalls: message ? extractToolCalls(message) : [],
      finishReason: normalizeFinishReason(response.choices[0]?.finish_reason),
      usage: response.usage,
      model: response.model ?? config.model,
      provider: config.provider,
      elapsedMs: elapsed,
    };

    logResponse(config, elapsed, result);
    return result;
  };

  try {
    return await tryCompletion(requestedTemp);
  } catch (err: any) {
    if (isTemperatureUnsupportedError(err, requestedTemp)) {
      console.warn(
        `[inference] Model ${config.model} does not support temperature=${requestedTemp}, retrying with temperature=1`,
      );
      return await tryCompletion(1);
    }

    const elapsed = Date.now() - start;
    console.error(
      `[inference] ✗ ${elapsed}ms provider=${config.provider} model=${config.model}` +
        ` | ${err?.status ?? "?"} ${err?.code ?? err?.type ?? err?.message ?? "unknown error"}`,
    );
    throw err;
  }
}
