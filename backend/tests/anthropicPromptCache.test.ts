import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnthropicMessageParams,
  buildAnthropicStreamParams,
} from "../src/utils/llm/anthropicParams";

const input = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "system", content: "You are a pentest agent." },
    { role: "user", content: "start" },
    { role: "assistant", content: "running nmap" },
    { role: "user", content: "continue" },
  ],
  tools: [
    {
      type: "function" as const,
      function: {
        name: "run_bash",
        description: "run",
        parameters: { type: "object" as const, properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "read",
        parameters: { type: "object" as const, properties: {} },
      },
    },
  ],
  enablePromptCache: true,
};

test("message params mark system, last tool and last message block as cacheable", () => {
  const params = buildAnthropicMessageParams(input);
  const system = params.system as Array<{ type: string; cache_control?: { type: string } }>;
  assert.equal(system[0].cache_control?.type, "ephemeral");
  const tools = params.tools!;
  assert.equal(tools[tools.length - 1].cache_control?.type, "ephemeral");
  assert.equal(tools[0].cache_control, undefined);
  const lastMsg = params.messages[params.messages.length - 1];
  const blocks = lastMsg.content as Array<{ type: string; cache_control?: { type: string } }>;
  assert.equal(blocks[blocks.length - 1].cache_control?.type, "ephemeral");
});

test("stream params carry the same cache breakpoints", () => {
  const params = buildAnthropicStreamParams(input, null);
  const system = params.system as Array<{ cache_control?: { type: string } }>;
  assert.equal(system[0].cache_control?.type, "ephemeral");
  assert.equal(params.tools![1].cache_control?.type, "ephemeral");
});

test("cache markers are absent when prompt caching is disabled", () => {
  const params = buildAnthropicMessageParams({ ...input, enablePromptCache: false });
  assert.equal(typeof params.system, "string");
  assert.equal(params.tools![0].cache_control, undefined);
});

test("volatile system tail is split off so the static prefix keeps the breakpoint", () => {
  const withVolatile = {
    ...input,
    messages: [
      {
        role: "system" as const,
        content:
          "Static system prompt.\n<volatile_system>\n<run_clock>Current time: 10:00</run_clock>\n</volatile_system>",
      },
      ...input.messages.slice(1),
    ],
  };
  const params = buildAnthropicMessageParams(withVolatile);
  const system = params.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
  assert.equal(system.length, 2);
  assert.ok(system[0].text.startsWith("Static system prompt."));
  assert.ok(system[0].text.includes("Static system prompt.") && !system[0].text.includes("<volatile_system>"));
  assert.equal(system[0].cache_control?.type, "ephemeral");
  assert.ok(system[1].text.includes("<volatile_system>"));
  assert.equal(system[1].cache_control, undefined);

  const stream = buildAnthropicStreamParams(withVolatile, null);
  const streamSystem = stream.system as Array<{ text: string; cache_control?: { type: string } }>;
  assert.equal(streamSystem[0].cache_control?.type, "ephemeral");
  assert.ok(streamSystem[1].text.includes("<volatile_system>"));
});

test("volatile tail is joined into one string when caching is disabled", () => {
  const withVolatile = {
    ...input,
    enablePromptCache: false,
    messages: [
      {
        role: "system" as const,
        content:
          "Static system prompt.\n<volatile_system>\n<run_clock>Current time: 10:00</run_clock>\n</volatile_system>",
      },
      ...input.messages.slice(1),
    ],
  };
  const params = buildAnthropicMessageParams(withVolatile);
  const system = params.system as string;
  assert.ok(system.startsWith("Static system prompt."));
  assert.ok(system.includes("<volatile_system>"));
});
