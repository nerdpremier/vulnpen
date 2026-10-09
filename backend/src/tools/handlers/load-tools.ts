import { ToolDefinition } from "../types";
import { DEFERRED_TOOLS, filterDeferredToolNames } from "../deferred";
import SessionsModel from "../../models/Sessions/Sessions.model";

const loadTools: ToolDefinition = {
  name: "load_tools",
  description:
    "Load deferred tools into your available tool set for the rest of this session. " +
    "Deferred tools are not in your tool list until you load them; once loaded they stay loaded. " +
    `Loadable tools: ${Array.from(DEFERRED_TOOLS).join(", ")}. ` +
    "Load them before you need them — Burp tools before proxy-driven or fuzzing work, " +
    "map_finding_owasp and generate_pentest_report when reporting, and read_report_document before you answer anything about what the " +
    "report currently says (the tester may have rewritten it in Word).",
  parameters: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Names of the deferred tools to load.",
      },
    },
    required: ["tools"],
  },
  timeoutMs: 10_000,
  async execute(args, ctx) {
    const { valid, unknown } = filterDeferredToolNames(args.tools);

    if (valid.length > 0) {
      await SessionsModel.updateOne(
        { sessionId: ctx.sessionId },
        { $addToSet: { loadedTools: { $each: valid } } },
      );
    }

    const lines: string[] = [];
    if (valid.length > 0) {
      lines.push(`Loaded and now available: ${valid.join(", ")}.`);
    }
    if (unknown.length > 0) {
      lines.push(
        `Not deferred tools (ignored): ${unknown.join(", ")}. Loadable: ${Array.from(DEFERRED_TOOLS).join(", ")}.`,
      );
    }
    if (lines.length === 0) {
      lines.push(`No tools requested. Loadable: ${Array.from(DEFERRED_TOOLS).join(", ")}.`);
    }
    return { output: lines.join("\n"), exitCode: 0 };
  },
};

export default loadTools;
