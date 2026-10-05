import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { StreamDelta } from "../src/utils/llm/types";
import {
  runAnthropicThinkingStream,
  runChatCompletionsStream,
  runOpenAIResponsesStream,
} from "../src/utils/llm/streaming";
import type { ProviderConfig, StreamingInvokeOptions } from "../src/utils/llm/types";
import { createStreamCollector } from "../src/utils/llm/streamCollector";

/** Collect every delta a pipeline emits, in order — the delta sequence IS the contract. */
function recorder(): { deltas: StreamDelta[]; onDelta: (d: StreamDelta) => void } {
  const deltas: StreamDelta[] = [];
  return { deltas, onDelta: (d) => deltas.push(d) };
}

const baseConfig: ProviderConfig = {
  provider: "openrouter",
  apiKey: "test-key",
  model: "test-model",
};

const streamingOpts = (onDelta: StreamingInvokeOptions["onDelta"]): StreamingInvokeOptions => ({
  messages: [{ role: "user", content: "hi" }],
  onDelta,
});

// ─── StreamCollector ─────────────────────────────────────────────────────

test("collector assembles text and reasoning, empty joins become null", () => {
  const { deltas, onDelta } = recorder();
  const collector = createStreamCollector(onDelta);

  collector.onText("hel");
  collector.onText("lo");
  collector.onReasoning("think");
  collector.onText(""); // ignored
  collector.onReasoning(null as never); // ignored

  const result = collector.finish();
  assert.equal(result.content, "hello");
  assert.equal(result.reasoning, "think");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(
    deltas.map((d) => ({ type: d.type, content: d.content })),
    [
      { type: "text", content: "hel" },
      { type: "text", content: "lo" },
      { type: "reasoning", content: "think" },
    ],
  );
});

test("collector owns the tool-call lifecycle: start, deltas, then done in start order", () => {
  const { deltas, onDelta } = recorder();
  const collector = createStreamCollector(onDelta);

  collector.startToolCall("a", "call-a", "run_bash");
  collector.appendToolCallArgs("a", '{"comm');
  collector.appendToolCallArgs("a", 'and":"ls"}');
  collector.startToolCall("b", "call-b", "view_image");
  collector.appendToolCallArgs("b", "{}");

  const result = collector.finish();

  // All start/delta events carry the sequential index; done events come last,
  // one per call, in start order, with the arguments joined.
  assert.deepEqual(
    deltas.map((d) => d.type),
    [
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_done",
      "tool_call_done",
    ],
  );
  assert.deepEqual(result.toolCalls, [
    { id: "call-a", name: "run_bash", arguments: '{"command":"ls"}' },
    { id: "call-b", name: "view_image", arguments: "{}" },
  ]);
  const doneA = deltas[5].toolCall!;
  assert.equal(doneA.index, 0);
  assert.equal(doneA.arguments, '{"command":"ls"}');
  const doneB = deltas[6].toolCall!;
  assert.equal(doneB.index, 1);
});

test("collector promotes stop to tool_calls only when calls exist", () => {
  const withCalls = createStreamCollector(() => {});
  withCalls.startToolCall("a", "id", "run_bash");
  assert.equal(withCalls.finish().finishReason, "tool_calls");

  const withoutCalls = createStreamCollector(() => {});
  withoutCalls.setFinishReason("stop");
  assert.equal(withoutCalls.finish().finishReason, "stop");

  const lengthWithCalls = createStreamCollector(() => {});
  lengthWithCalls.setFinishReason("length");
  lengthWithCalls.startToolCall("a", "id", "run_bash");
  // A truncation is not a clean tool-call turn — the length reason survives.
  assert.equal(lengthWithCalls.finish().finishReason, "length");
});

test("collector supports late id/name patches and argument replacement", () => {
  const { deltas, onDelta } = recorder();
  const collector = createStreamCollector(onDelta);

  // chat-completions style: the first chunk may carry no id/name yet.
  collector.startToolCall("0", undefined, undefined);
  collector.updateToolCall("0", { id: "late-id", name: "run_bash" });
  collector.appendToolCallArgs("0", '{"st');
  // Responses style: arguments.done replaces the accumulated text.
  collector.replaceToolCallArgs("0", '{"complete": true}');

  const result = collector.finish();
  assert.deepEqual(result.toolCalls, [
    { id: "late-id", name: "run_bash", arguments: '{"complete": true}' },
  ]);
});

test("collector ignores argument chunks for unknown keys", () => {
  const { deltas, onDelta } = recorder();
  const collector = createStreamCollector(onDelta);
  collector.appendToolCallArgs("ghost", '{"x":1}');
  collector.replaceToolCallArgs("ghost", "{}");
  collector.updateToolCall("ghost", { id: "x" });
  assert.deepEqual(collector.finish().toolCalls, []);
  assert.deepEqual(deltas, []);
});

// ─── Anthropic native pipeline ───────────────────────────────────────────

function fakeAnthropicClient(events: any[]): Anthropic {
  return {
    messages: {
      stream: () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    },
  } as unknown as Anthropic;
}

test("anthropic pipeline pumps thinking, text, tool use, and merges usage", async () => {
  const { deltas, onDelta } = recorder();
  const client = fakeAnthropicClient([
    {
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1 } },
    },
    {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "why" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "run_bash" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"comm' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'and":"ls"}' },
    },
    { type: "content_block_delta", delta: { type: "text_delta", text: "scanning" } },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 42 },
    },
  ]);

  const result = await runAnthropicThinkingStream(
    client,
    { ...baseConfig, provider: "anthropic" },
    streamingOpts(onDelta),
    null,
    0,
  );

  assert.deepEqual(
    deltas.map((d) => d.type),
    [
      "reasoning",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "text",
      "tool_call_done",
    ],
  );
  assert.equal(result.content, "scanning");
  assert.equal(result.reasoning, "why");
  assert.deepEqual(result.toolCalls, [
    { id: "tu_1", name: "run_bash", arguments: '{"command":"ls"}' },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  // message_start carries the prompt tokens, message_delta only the output —
  // the merge must keep both.
  assert.deepEqual(result.usage, {
    prompt_tokens: 100,
    completion_tokens: 42,
    total_tokens: 142,
  });
});

test("anthropic pipeline stops cleanly on abort", async () => {
  const { deltas, onDelta } = recorder();
  const controller = new AbortController();
  controller.abort();
  const client = fakeAnthropicClient([
    { type: "content_block_delta", delta: { type: "text_delta", text: "never seen" } },
  ]);

  const result = await runAnthropicThinkingStream(
    client,
    { ...baseConfig, provider: "anthropic" },
    { ...streamingOpts(onDelta), abortSignal: controller.signal },
    null,
    0,
  );

  assert.equal(result.content, null);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(deltas, []);
});

// ─── OpenAI Responses pipeline ───────────────────────────────────────────

function fakeResponsesClient(events: any[]): OpenAI {
  return {
    responses: {
      create: async () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    },
  } as unknown as OpenAI;
}

test("responses pipeline assembles function calls and honors arguments.done", async () => {
  const { deltas, onDelta } = recorder();
  const client = fakeResponsesClient([
    {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "fc_1", name: "run_bash" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: '{"comm',
    },
    // arguments.done carries the full arguments and replaces the accumulated text
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: '{"command":"id"}',
    },
    { type: "response.output_text.delta", delta: "hello" },
    {
      type: "response.completed",
      response: {
        model: "gpt-5.6",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    },
  ]);

  const result = await runOpenAIResponsesStream(
    client,
    { ...baseConfig, provider: "openai" },
    streamingOpts(onDelta),
    "medium",
    0,
  );

  assert.deepEqual(
    deltas.map((d) => d.type),
    ["tool_call_start", "tool_call_delta", "text", "tool_call_done"],
  );
  assert.deepEqual(result.toolCalls, [
    { id: "fc_1", name: "run_bash", arguments: '{"command":"id"}' },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.model, "gpt-5.6");
  assert.deepEqual(result.usage, {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  });
});

test("responses pipeline falls back to the last started call on mismatched item ids", async () => {
  const { deltas, onDelta } = recorder();
  const client = fakeResponsesClient([
    {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "fc_1", name: "run_bash" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "wrong-id",
      delta: '{"command":"ls"}',
    },
    { type: "response.completed", response: { status: "completed" } },
  ]);

  const result = await runOpenAIResponsesStream(
    client,
    { ...baseConfig, provider: "openai" },
    streamingOpts(onDelta),
    "medium",
    0,
  );

  assert.deepEqual(result.toolCalls, [
    { id: "fc_1", name: "run_bash", arguments: '{"command":"ls"}' },
  ]);
});

// ─── Chat completions pipeline ───────────────────────────────────────────

function fakeChatClient(chunks: any[]): { client: OpenAI; params: any[] } {
  const params: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (p: any) => {
          params.push(p);
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { client, params };
}

test("chat completions pipeline handles reasoning variants, tool indexes, and usage", async () => {
  const { deltas, onDelta } = recorder();
  const { client } = fakeChatClient([
    {
      choices: [{ delta: { reasoning_content: "ponder", content: null } }],
    },
    {
      choices: [{ delta: { reasoning: "more" } }],
    },
    {
      choices: [
        {
          delta: {
            content: "running",
            tool_calls: [
              { index: 0, id: "tc_0", function: { name: "run_bash", arguments: "" } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }],
          },
        },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      model: "served-model",
    },
  ]);

  const result = await runChatCompletionsStream(
    client,
    baseConfig,
    streamingOpts(onDelta),
    "off",
    0.7,
    0,
  );

  assert.deepEqual(
    deltas.map((d) => d.type),
    [
      "reasoning",
      "reasoning",
      "text",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_done",
    ],
  );
  assert.equal(result.content, "running");
  assert.equal(result.reasoning, "pondermore");
  assert.deepEqual(result.toolCalls, [
    { id: "tc_0", name: "run_bash", arguments: '{"command":"ls"}' },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.model, "served-model");
  assert.deepEqual(result.usage, {
    prompt_tokens: 5,
    completion_tokens: 7,
    total_tokens: 12,
  });
});

test("chat completions pipeline promotes stop to tool_calls and maps kimi effort", async () => {
  const { deltas, onDelta } = recorder();
  const { client, params } = fakeChatClient([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "t", function: { name: "n", arguments: "{}" } }],
          },
        },
      ],
    },
  ]);

  const result = await runChatCompletionsStream(
    client,
    { ...baseConfig, provider: "kimi" },
    streamingOpts(onDelta),
    "medium",
    0.7,
    0,
  );

  // kimi reasoning ladder: anything between low and max is "high"
  assert.equal(params[0].reasoning_effort, "high");
  assert.equal(result.finishReason, "tool_calls", "stop promoted because tool calls exist");
  assert.deepEqual(result.toolCalls, [
    { id: "t", name: "n", arguments: "{}" },
  ]);
});
