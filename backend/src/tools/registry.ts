import OpenAI from "openai";
import { ToolDefinition, toolToOpenAISchema } from "./types";

import runBash from "./handlers/run-bash";
import runPythonScript from "./handlers/run-python-script";
import runInstallTool from "./handlers/run-install-tool";
import askUser from "./handlers/generic-response";
import spawnShell from "./handlers/spawn-shell";
import writeToShell from "./handlers/write-to-shell";
import readShell from "./handlers/read-shell";
import listShells from "./handlers/list-shells";
import closeShell from "./handlers/close-shell";
import sendToBurp from "./handlers/send-to-burp";
import burpIntruder from "./handlers/burp-intruder";
import burpCollaborator from "./handlers/burp-collaborator";
import burpProxyHistory from "./handlers/burp-proxy-history";
import magnitudeBrowser from "./handlers/magnitude-browser";
import viewImage from "./handlers/view-image";
import updateEngagementState from "./handlers/update-engagement-state";
import wstgTestPlan from "./handlers/wstg-test-plan";
import mapFindingOwasp from "./handlers/map-finding-owasp";
import generatePentestReport from "./handlers/generate-pentest-report";
import readReportDocument from "./handlers/read-report-document";
import loadTools from "./handlers/load-tools";
import { DEFERRED_TOOLS } from "./deferred";

class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  toOpenAISchemas(opts?: {
    disabledTools?: string[];
    unconfiguredTools?: string[];
    /** Deferred tools explicitly loaded for this session via `load_tools`. */
    loadedTools?: string[];
  }): OpenAI.Chat.ChatCompletionTool[] {
    let tools = this.getAll();
    if (opts?.disabledTools?.length) {
      const disabled = new Set(opts.disabledTools);
      tools = tools.filter((t) => !disabled.has(t.name));
    }
    if (opts?.unconfiguredTools?.length) {
      const unconf = new Set(opts.unconfiguredTools);
      tools = tools.filter((t) => !unconf.has(t.name));
    }
    const loaded = new Set(opts?.loadedTools ?? []);
    tools = tools.filter((t) => !DEFERRED_TOOLS.has(t.name) || loaded.has(t.name));
    return tools.map(toolToOpenAISchema);
  }
}

export const toolRegistry = new ToolRegistry();

toolRegistry.register(runBash);
toolRegistry.register(runPythonScript);
toolRegistry.register(runInstallTool);
toolRegistry.register(askUser);
toolRegistry.register(spawnShell);
toolRegistry.register(writeToShell);
toolRegistry.register(readShell);
toolRegistry.register(listShells);
toolRegistry.register(closeShell);
toolRegistry.register(sendToBurp);
toolRegistry.register(burpIntruder);
toolRegistry.register(burpCollaborator);
toolRegistry.register(burpProxyHistory);
toolRegistry.register(magnitudeBrowser);
toolRegistry.register(viewImage);
toolRegistry.register(updateEngagementState);
toolRegistry.register(wstgTestPlan);
toolRegistry.register(mapFindingOwasp);
toolRegistry.register(generatePentestReport);
toolRegistry.register(readReportDocument);
toolRegistry.register(loadTools);
