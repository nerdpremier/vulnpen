import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { LangfuseGeneration } from "@langfuse/tracing";
import { startObservation } from "@langfuse/tracing";
import { isTracingEnabled } from "../tracing";
import { buildAnthropicStreamParams } from "./anthropicParams";
import { createStreamCollector } from "./streamCollector";
import { invokeSubscriptionInference, isSubscriptionProvider } from "../../services/subscription-inference.service";
import {
  buildAnthropicClient,
  buildClient,
  isAnthropicApiProvider,
} from "./provider-config";
import { resolveInvocationProvider } from "./orchestrator";
import { getModelMaxOutput } from "../modelMetadata";
import {
  assertCompletionChoices,
  buildCompletionConfig,
  clampTemperature,
  getClient,
  isTemperatureUnsupportedError,
  kimiReasoningEffort,
  logRequest,
  logResponse,
  normalizeFinishReason,
} from "./invoke";
import type {
  FinishReason,
  InvokeResult,
  ProviderConfig,
  ReasoningMode,
  StreamingInvokeOptions,
  ToolCallData,
} from "./types";

// ─── Streaming ───────────────────────────────────────────────────────
// The streaming family: the dispatcher (invoke_llm_streaming) and the
// three provider pipelines — Anthropic native, OpenAI Responses, chat
// completions — plus the JSON-in-prompt fallback. The pipelines are event
// pumps over the stream collector and own only what genuinely differs per
// provider (Anthropic's usage merge, Responses' item ids, chunk-level
// usage/model); shared request plumbing comes from invoke.ts.

const ANTHROPIC_BUDGET_TOKENS: Record<Exclude<ReasoningMode, "off">, number> = {
  low: 4096,
  medium: 10000,
  high: 32000,
  xhigh: 48000,
  max: 64000,
};

/**
 * The provider pipelines are the event pumps: they translate one SDK's
 * stream into collector calls and own only what genuinely differs per
 * provider (Anthropic's usage merge, Responses' item ids, chunk-level
 * usage/model). Exported for fixture tests — internal seam, not for
 * production callers.
 */
export async function runAnthropicThinkingStream(
  client: Anthropic,
  config: ProviderConfig,
  opts: StreamingInvokeOptions,
  budgetTokens: number | null,
  start: number,
): Promise<InvokeResult> {
  const params = buildAnthropicStreamParams(
    {
      model: config.model,
      messages: opts.messages,
      tools: opts.tools,
      reasoningMode: opts.reasoningMode,
      enablePromptCache: true,
    },
    budgetTokens,
  );

  console.log(
    budgetTokens
      ? `[inference] → anthropic-native model=${config.model} thinking budget=${budgetTokens}`
      : `[inference] → anthropic-native model=${config.model}`,
  );

  const stream = client.messages.stream(params);

  const collector = createStreamCollector(opts.onDelta);
  let usage: OpenAI.Completions.CompletionUsage | undefined;

  for await (const event of stream) {
    if (opts.abortSignal?.aborted) {
      collector.setFinishReason("stop");
      break;
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as any;
      if (delta.type === "thinking_delta") collector.onReasoning(delta.thinking);
      if (delta.type === "text_delta") collector.onText(delta.text);
      if (delta.type === "input_json_delta") {
        collector.appendToolCallArgs(String(event.index), delta.partial_json);
      }
    }

    if (event.type === "content_block_start") {
      const block = (event as any).content_block;
      if (block?.type === "tool_use") {
        collector.startToolCall(String(event.index), block.id, block.name);
      }
    }

    if (event.type === "message_delta") {
      const md = event as any;
      if (md.delta?.stop_reason) {
        collector.setFinishReason(normalizeFinishReason(md.delta.stop_reason));
      }
      if (md.usage) {
        // message_delta arrives after message_start and only carries output
        // tokens; merge instead of replacing so prompt_tokens survives.
        const output = md.usage.output_tokens ?? 0;
        const prompt = usage?.prompt_tokens ?? 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: output,
          total_tokens: prompt + output,
        };
      }
    }

    if (event.type === "message_start") {
      const ms = event as any;
      if (ms.message?.usage) {
        const u = ms.message.usage;
        usage = {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        };
      }
    }
  }

  const { content, reasoning, toolCalls, finishReason } = collector.finish();

  const elapsed = Date.now() - start;
  const result: InvokeResult = {
    content,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    model: config.model,
    provider: config.provider,
    elapsedMs: elapsed,
  };

  logResponse(config, elapsed, result);
  return result;
}

// ─── OpenAI Responses API streaming (for reasoning summary) ─────────

function openaiToResponsesInput(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): { instructions: string; input: any[] } {
  let instructions = "";
  const input: any[] = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      instructions += (typeof m.content === "string" ? m.content : "") + "\n";
      continue;
    }
    if (m.role === "user") {
      input.push({
        role: "user",
        content:
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
      continue;
    }
    if (m.role === "assistant") {
      const am = m as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      if (am.tool_calls?.length) {
        if (am.content) {
          input.push({
            role: "assistant",
            content:
              typeof am.content === "string"
                ? am.content
                : JSON.stringify(am.content),
          });
        }
        for (const tc of am.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else {
        input.push({
          role: "assistant",
          content:
            typeof am.content === "string"
              ? am.content
              : JSON.stringify(am.content ?? ""),
        });
      }
      continue;
    }
    if (m.role === "tool") {
      const tm = m as OpenAI.Chat.ChatCompletionToolMessageParam;
      input.push({
        type: "function_call_output",
        call_id: tm.tool_call_id,
        output:
          typeof tm.content === "string"
            ? tm.content
            : JSON.stringify(tm.content),
      });
    }
  }

  return { instructions: instructions.trim(), input };
}

function openaiToResponsesTools(
  tools?: OpenAI.Chat.ChatCompletionTool[],
): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

/**
 * Same shape as Chat Completions (`messages` + optional `tools`) so Langfuse shows a normal
 * system → user → assistant transcript instead of Responses API `input` + `instructions` in metadata.
 */
function buildLangfuseChatCompletionInput(
  opts: StreamingInvokeOptions,
): Record<string, unknown> {
  const input: Record<string, unknown> = { messages: opts.messages };
  if (opts.tools?.length) {
    input.tools = opts.tools;
    input.tool_choice = "auto";
  }
  return input;
}

function buildLangfuseResponsesOutput(params: {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCallData[];
}): unknown {
  const { content, reasoning, toolCalls } = params;
  const base: Record<string, unknown> = {
    role: "assistant",
    content: content ?? "",
  };
  if (reasoning) {
    base.reasoning_summary = reasoning;
  }
  if (toolCalls.length > 0) {
    base.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return base;
}

function usageToLangfuseDetails(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? 0,
  };
}

export async function runOpenAIResponsesStream(
  rawClient: OpenAI,
  config: ProviderConfig,
  opts: StreamingInvokeOptions,
  reasoningMode: Exclude<ReasoningMode, "off">,
  start: number,
): Promise<InvokeResult> {
  // Raw client: observeOpenAI maps Responses API params poorly (no `messages` in trace input).
  // We record a manual generation with Chat Completions–shaped input instead.
  const { instructions, input } = openaiToResponsesInput(opts.messages);
  const maxOutputTokens = getModelMaxOutput(config.model, config.maxOutputTokens);
  const responsesTools = openaiToResponsesTools(opts.tools);

  const params: any = {
    model: config.model,
    input,
    stream: true,
    reasoning: { effort: reasoningMode, summary: "auto" },
    max_output_tokens: maxOutputTokens,
    ...(instructions ? { instructions } : {}),
    ...(responsesTools ? { tools: responsesTools, tool_choice: "auto" } : {}),
  };

  console.log(
    `[inference] → openai-responses model=${config.model} reasoning effort=${reasoningMode}`,
  );

  let generation: LangfuseGeneration | undefined;
  if (isTracingEnabled()) {
    generation = startObservation(
      opts.generationName ?? "OpenAI.responses.create",
      {
        model: config.model,
        input: buildLangfuseChatCompletionInput(opts),
        metadata: {
          api: "openai.responses",
          reasoning_effort: reasoningMode,
        },
      },
      { asType: "generation" },
    ).updateTrace({
      userId: opts.userId,
      sessionId: opts.sessionId,
      tags: opts.tags,
    });
  }

  let completionStartTime: Date | undefined;
  const endGeneration = (
    attrs: Parameters<LangfuseGeneration["update"]>[0],
  ) => {
    if (generation) {
      generation.update(attrs);
      generation.end();
      generation = undefined;
    }
  };

  const collector = createStreamCollector(opts.onDelta);
  let lastToolCallKey: string | undefined;
  let responsesToolCallCount = 0;
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  let model = config.model;

  try {
    const stream = (await rawClient.responses.create(
      params,
    )) as unknown as AsyncIterable<any>;

    for await (const event of stream) {
      if (completionStartTime === undefined) {
        completionStartTime = new Date();
      }
      if (opts.abortSignal?.aborted) {
        collector.setFinishReason("stop");
        break;
      }

      switch (event.type) {
        case "response.output_text.delta": {
          collector.onText(event.delta as string);
          break;
        }

        case "response.reasoning_summary_text.delta": {
          collector.onReasoning(event.delta as string);
          break;
        }

        case "response.output_item.added": {
          const item = event.item;
          if (item?.type === "function_call") {
            const key = item.call_id ?? item.id ?? `tc_${responsesToolCallCount++}`;
            lastToolCallKey = key;
            collector.startToolCall(key, item.call_id ?? item.id, item.name);
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const itemId = event.item_id as string;
          // A mismatched item_id falls back to the most recently started call.
          const key = collector.hasToolCall(itemId) ? itemId : lastToolCallKey;
          if (key) collector.appendToolCallArgs(key, event.delta as string);
          break;
        }

        case "response.function_call_arguments.done": {
          const itemId = event.item_id as string;
          const key = collector.hasToolCall(itemId) ? itemId : lastToolCallKey;
          if (key) collector.replaceToolCallArgs(key, event.arguments);
          break;
        }

        case "response.completed": {
          const resp = event.response;
          if (resp?.model) model = resp.model;
          if (resp?.status === "incomplete") {
            collector.setFinishReason("length");
          }
          if (resp?.usage) {
            usage = {
              prompt_tokens: resp.usage.input_tokens ?? 0,
              completion_tokens: resp.usage.output_tokens ?? 0,
              total_tokens:
                (resp.usage.input_tokens ?? 0) +
                (resp.usage.output_tokens ?? 0),
            };
          }
          break;
        }

        case "response.failed": {
          const resp = event.response;
          const errMsg = resp?.error?.message ?? "Unknown Responses API error";
          console.error(`[inference] Responses API failed: ${errMsg}`);
          throw new Error(errMsg);
        }
      }
    }

    const { content, reasoning, toolCalls, finishReason } = collector.finish();

    const elapsed = Date.now() - start;
    const result: InvokeResult = {
      content,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      model,
      provider: config.provider,
      elapsedMs: elapsed,
    };

    logResponse(config, elapsed, result);

    endGeneration({
      output: buildLangfuseResponsesOutput({
        content: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
      }),
      usageDetails: usageToLangfuseDetails(result.usage),
      model: result.model,
      completionStartTime,
    });

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    endGeneration({
      level: "ERROR",
      statusMessage: msg,
      usageDetails: usageToLangfuseDetails(usage),
      model,
    });
    throw err;
  }
}

// ─── Chat-completions streaming ──────────────────────────────────────

/**
 * Chat-completions streaming: the event pump for every OpenAI-compatible
 * provider (openai, openrouter, ollama, kimi, gateways). Exported for fixture
 * tests — internal seam, not for production callers.
 */
export async function runChatCompletionsStream(
  client: OpenAI,
  config: ProviderConfig,
  opts: StreamingInvokeOptions,
  reasoningMode: ReasoningMode,
  temp: number,
  start: number,
): Promise<InvokeResult> {
  const params = buildCompletionConfig(config, opts, temp, true);

  if (
    reasoningMode !== "off" &&
    (config.provider === "openai-compatible" ||
      config.provider === "openrouter" ||
      config.provider === "ollama" ||
      config.provider === "kimi")
  ) {
    params.reasoning_effort =
      config.provider === "kimi"
        ? kimiReasoningEffort(reasoningMode)
        : reasoningMode;
  }

  const stream = (await client.chat.completions.create(
    params,
  )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

  const collector = createStreamCollector(opts.onDelta);
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  let model = config.model;

  for await (const chunk of stream) {
    if (opts.abortSignal?.aborted) {
      collector.setFinishReason("stop");
      break;
    }

    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage as any;

    const delta = chunk.choices?.[0]?.delta;
    const chunkFinish = chunk.choices?.[0]?.finish_reason;

    if (chunkFinish) {
      collector.setFinishReason(normalizeFinishReason(chunkFinish));
    }

    if (!delta) continue;

    const d = delta as Record<string, unknown>;
    const reasoningContent =
      (typeof d.reasoning_content === "string"
        ? d.reasoning_content
        : null) ??
      (typeof d.reasoning_text === "string" ? d.reasoning_text : null) ??
      (d.reasoning_text &&
      typeof (d.reasoning_text as { text?: string }).text === "string"
        ? (d.reasoning_text as { text: string }).text
        : null) ??
      (typeof d.reasoning === "string" ? d.reasoning : null);
    collector.onReasoning(reasoningContent ?? "");
    collector.onText(delta.content);

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const key = String(tc.index ?? 0);
        if (!collector.hasToolCall(key)) {
          collector.startToolCall(key, tc.id, tc.function?.name);
        }
        collector.updateToolCall(key, { id: tc.id, name: tc.function?.name });
        if (tc.function?.arguments) {
          collector.appendToolCallArgs(key, tc.function.arguments);
        }
      }
    }
  }

  const { content, reasoning, toolCalls, finishReason } = collector.finish();

  const elapsed = Date.now() - start;
  const result: InvokeResult = {
    content,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    model,
    provider: config.provider,
    elapsedMs: elapsed,
  };

  logResponse(config, elapsed, result);
  return result;
}

// ─── invoke_llm_streaming — streaming with tool calls ────────────────

export async function invoke_llm_streaming(
  opts: StreamingInvokeOptions,
): Promise<InvokeResult> {
  const config = await resolveInvocationProvider(opts);
  const reasoningMode = opts.reasoningMode ?? "off";
  const start = Date.now();

  if (isSubscriptionProvider(config.provider)) {
    logRequest(config, opts, true);
    const result = await invokeSubscriptionInference({
      provider: config.provider,
      model: config.model,
      reasoningMode,
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
      abortSignal: opts.abortSignal,
    });
    if (result.reasoning) {
      opts.onDelta({ type: "reasoning", content: result.reasoning });
    }
    if (result.content) {
      opts.onDelta({ type: "text", content: result.content });
    }
    result.toolCalls.forEach((toolCall, index) => {
      opts.onDelta({
        type: "tool_call_start",
        toolCall: { index, id: toolCall.id, name: toolCall.name },
      });
      opts.onDelta({
        type: "tool_call_done",
        toolCall: { index, ...toolCall },
      });
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
    const budget =
      reasoningMode !== "off" ? ANTHROPIC_BUDGET_TOKENS[reasoningMode] : null;
    logRequest(config, opts, true);
    return await runAnthropicThinkingStream(
      buildAnthropicClient(config),
      config,
      opts,
      budget,
      start,
    );
  }

  if (reasoningMode !== "off" && config.provider === "openai") {
    logRequest(config, opts, true);
    return await runOpenAIResponsesStream(
      buildClient(config),
      config,
      opts,
      reasoningMode,
      start,
    );
  }

  const client = getClient(config, opts);
  const requestedTemp = clampTemperature(
    config.model,
    opts.temperature ?? 0.75,
  );

  logRequest(config, opts, true);

  try {
    return await runChatCompletionsStream(
      client,
      config,
      opts,
      reasoningMode,
      requestedTemp,
      start,
    );
  } catch (err: any) {
    if (isTemperatureUnsupportedError(err, requestedTemp)) {
      console.warn(`[inference] Retrying stream with temperature=1`);
      return await runChatCompletionsStream(
        client,
        config,
        opts,
        reasoningMode,
        1,
        start,
      );
    }

    const isToolsUnsupported =
      opts.tools?.length &&
      (err?.message?.includes("tool") || err?.code === "unsupported_parameter");

    if (isToolsUnsupported) {
      console.warn(
        `[inference] Provider does not support native tool calling, falling back to JSON-in-prompt`,
      );
      return await invoke_llm_json_fallback(opts, config, start);
    }

    const elapsed = Date.now() - start;
    console.error(
      `[inference] ✗ ${elapsed}ms stream provider=${config.provider} model=${config.model}` +
        ` | ${err?.status ?? "?"} ${err?.code ?? err?.type ?? err?.message ?? "unknown error"}`,
    );
    throw err;
  }
}

// ─── JSON-in-prompt fallback for providers without native tool calling ───

function buildToolDescriptionPrompt(
  tools: OpenAI.Chat.ChatCompletionTool[],
): string {
  const descriptions = tools
    .map((t) => {
      const fn = t.function;
      return `- **${fn.name}**: ${fn.description}\n  Parameters: ${JSON.stringify(fn.parameters)}`;
    })
    .join("\n");

  return `You have access to the following tools. To use a tool, respond with a JSON object containing "tool_calls" array. Each element should have "name" (tool name) and "arguments" (object with the tool parameters). If you don't need to use a tool, respond normally without the tool_calls field.

Available tools:
${descriptions}

When using tools, respond ONLY with this JSON format:
{"content": "your thinking/explanation", "tool_calls": [{"name": "tool_name", "arguments": {...}}]}

When NOT using tools, respond with plain text.`;
}

async function invoke_llm_json_fallback(
  opts: StreamingInvokeOptions,
  config: ProviderConfig,
  startTime: number,
): Promise<InvokeResult> {
  const client = getClient(config, opts);

  const messages = [...opts.messages];
  if (opts.tools?.length) {
    const toolPrompt = buildToolDescriptionPrompt(opts.tools);
    const sysIdx = messages.findIndex((m) => m.role === "system");
    if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
      messages[sysIdx] = {
        ...messages[sysIdx],
        content: (messages[sysIdx] as any).content + "\n\n" + toolPrompt,
      };
    } else {
      messages.unshift({ role: "system", content: toolPrompt });
    }
  }

  const params: any = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0.75,
  };

  const response = (await client.chat.completions.create(
    params,
  )) as OpenAI.Chat.ChatCompletion;
  assertCompletionChoices(response);
  const elapsed = Date.now() - startTime;
  const rawContent = response.choices[0]?.message?.content ?? "";

  let content: string | null = rawContent;
  let toolCalls: ToolCallData[] = [];
  let finishReason: FinishReason = "stop";

  try {
    const parsed = JSON.parse(rawContent);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      content = parsed.content || null;
      toolCalls = parsed.tool_calls.map((tc: any, i: number) => ({
        id: `fallback_${Date.now()}_${i}`,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments ?? {}),
      }));
      finishReason = "tool_calls";
    }
  } catch {
    // Not JSON, treat as plain text
  }

  if (content) opts.onDelta({ type: "text", content });
  for (const tc of toolCalls) {
    opts.onDelta({ type: "tool_call_start", toolCall: tc });
    opts.onDelta({ type: "tool_call_done", toolCall: tc });
  }

  const result: InvokeResult = {
    content,
    reasoning: null,
    toolCalls,
    finishReason,
    usage: response.usage,
    model: response.model ?? config.model,
    provider: config.provider,
    elapsedMs: elapsed,
  };

  logResponse(config, elapsed, result);
  return result;
}
