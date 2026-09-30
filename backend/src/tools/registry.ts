import OpenAI from "openai";
import { ToolDefinition, toolToOpenAISchema, AgentRole } from "./types";

import runBash from "./handlers/run-bash";
import runPythonScript from "./handlers/run-python-script";
import runInstallTool from "./handlers/run-install-tool";
import askUser from "./handlers/generic-response";
import spawnShell from "./handlers/spawn-shell";
import writeToShell from "./handlers/write-to-shell";
import readShell from "./handlers/read-shell";
import listShells from "./handlers/list-shells";
import closeShell from "./handlers/close-shell";
import spawnSubagent from "./handlers/spawn-subagent";
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
    excludeSubagent?: boolean;
    agentRole?: AgentRole;
    disabledTools?: string[];
    unconfiguredTools?: string[];
  }): OpenAI.Chat.ChatCompletionTool[] {
    let tools = this.getAll();
    if (opts?.agentRole) {
      tools = tools.filter((t) => {
        if (!t.allowedRoles) {
          return opts.agentRole !== "orchestrator";
        }
        return t.allowedRoles.includes(opts.agentRole!);
      });
    } else if (opts?.excludeSubagent) {
      tools = tools.filter((t) => t.name !== "spawn_subagent");
    }
    if (opts?.disabledTools?.length) {
      const disabled = new Set(opts.disabledTools);
      tools = tools.filter((t) => !disabled.has(t.name));
    }
    if (opts?.unconfiguredTools?.length) {
      const unconf = new Set(opts.unconfiguredTools);
      tools = tools.filter((t) => !unconf.has(t.name));
    }
    return tools.map(toolToOpenAISchema);
  }

  requiresConsent(name: string): boolean {
    return this.tools.get(name)?.requiresConsent ?? false;
  }

  getTimeout(name: string): number {
    return this.tools.get(name)?.timeoutMs ?? 300_000;
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
toolRegistry.register(spawnSubagent);
toolRegistry.register(sendToBurp);
toolRegistry.register(burpIntruder);
toolRegistry.register(burpCollaborator);
// toolRegistry.register(burpProxyControl);
toolRegistry.register(burpProxyHistory);
toolRegistry.register(magnitudeBrowser);
toolRegistry.register(viewImage);
toolRegistry.register(updateEngagementState);
toolRegistry.register(wstgTestPlan);
toolRegistry.register(mapFindingOwasp);
toolRegistry.register(generatePentestReport);
