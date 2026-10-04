import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBrowserAgentConfig,
  parseViewport,
  hasLiveBrowserAgent,
} from "../src/services/browser-agent.service";
import type { BrowserAgentRuntimeConfig } from "../src/services/browser-agent.service";

const baseConfig: BrowserAgentRuntimeConfig = {
  llm: {
    provider: "openai-generic",
    options: {
      model: "gpt-x",
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
    },
  },
  headless: true,
  proxyUrl: "",
  display: ":99",
  screen: "1280x800x24",
};

test("parseViewport reads Xvfb geometry and falls back to defaults", () => {
  assert.deepEqual(parseViewport("1280x800x24"), { width: 1280, height: 800 });
  assert.deepEqual(parseViewport("1024x768x24"), { width: 1024, height: 768 });
  assert.deepEqual(parseViewport(""), { width: 1280, height: 800 });
  assert.deepEqual(parseViewport("garbage"), { width: 1280, height: 800 });
});

test("buildBrowserAgentConfig carries viewport and llm into the agent config", () => {
  const { agentConfig } = buildBrowserAgentConfig(baseConfig);
  assert.equal(agentConfig.browser.contextOptions.viewport.width, 1280);
  assert.equal(agentConfig.browser.contextOptions.viewport.height, 800);
  assert.equal(agentConfig.browser.contextOptions.ignoreHTTPSErrors, true);
  assert.equal(agentConfig.llm.provider, "openai-generic");
  assert.equal(agentConfig.llm.options.model, "gpt-x");
  assert.equal(agentConfig.narrate, false);
});

test("headless launches without a window size override", () => {
  const { agentConfig } = buildBrowserAgentConfig(baseConfig);
  assert.equal(agentConfig.browser.launchOptions.headless, true);
  assert.equal(agentConfig.browser.launchOptions.args, undefined);
  assert.equal(typeof agentConfig.browser.launchOptions.env.HOME, "string");
});

test("headed launches size the window to the screen and set DISPLAY", () => {
  const { agentConfig } = buildBrowserAgentConfig({
    ...baseConfig,
    headless: false,
  });
  assert.equal(agentConfig.browser.launchOptions.headless, false);
  assert.deepEqual(agentConfig.browser.launchOptions.args, [
    "--window-size=1280,800",
  ]);
  assert.equal(agentConfig.browser.launchOptions.env.DISPLAY, ":99");
});

test("proxy is wired into launch options when set", () => {
  const { agentConfig } = buildBrowserAgentConfig({
    ...baseConfig,
    proxyUrl: "http://burp:8080",
  });
  assert.deepEqual(agentConfig.browser.launchOptions.proxy, {
    server: "http://burp:8080",
  });
});

test("fingerprint changes when anything baked into the agent changes", () => {
  const base = buildBrowserAgentConfig(baseConfig).fingerprint;
  assert.equal(buildBrowserAgentConfig({ ...baseConfig }).fingerprint, base);

  const model = buildBrowserAgentConfig({
    ...baseConfig,
    llm: {
      provider: baseConfig.llm.provider,
      options: { ...baseConfig.llm.options, model: "gpt-y" },
    },
  }).fingerprint;
  assert.notEqual(base, model);

  const headless = buildBrowserAgentConfig({
    ...baseConfig,
    headless: false,
  }).fingerprint;
  assert.notEqual(base, headless);

  const proxy = buildBrowserAgentConfig({
    ...baseConfig,
    proxyUrl: "http://burp:8080",
  }).fingerprint;
  assert.notEqual(base, proxy);

  const screen = buildBrowserAgentConfig({
    ...baseConfig,
    screen: "1024x768x24",
  }).fingerprint;
  assert.notEqual(base, screen);
});

test("no agent is live before any run", () => {
  assert.equal(hasLiveBrowserAgent(), false);
});
