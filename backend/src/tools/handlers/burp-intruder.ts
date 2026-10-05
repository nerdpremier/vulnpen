import { ToolDefinition } from "../types";
import {
  burpNotReady,
  burpFailureToToolOutput,
  encodeBurpBody,
  normalizeHttpRequest,
  withBurpClient,
} from "../../services/burp-client.service";
import { rawRequestSafetyDetail } from "../../utils/consentDetail";

const burpIntruder: ToolDefinition = {
  name: "send_to_burp_intruder",
  description:
    "Send an HTTP request to Burp Suite's Intruder for automated brute-force and payload-based testing. " +
    "Use this when you need to test many payloads against the same request — brute-forcing credentials, " +
    "fuzzing parameters with wordlists, enumerating valid IDs/tokens, or testing multiple injection " +
    "points simultaneously. Provide a raw HTTP request and optionally specify byte-offset insertion " +
    "points where Intruder will place payloads. " +
    "Proof-of-concept engagement: destructive steps are refused outright (see <rules_of_engagement>) — proving that a control is missing is the finding.",
  parameters: {
    type: "object",
    properties: {
      host: {
        type: "string",
        description: "Target hostname (e.g. example.com)",
      },
      port: {
        type: "number",
        description: "Target port (default 443)",
      },
      secure: {
        type: "boolean",
        description: "Use TLS/HTTPS (default true)",
      },
      raw_request: {
        type: "string",
        description: "Full raw HTTP request including request line, headers, and body.",
      },
      tab_name: {
        type: "string",
        description: "Optional name for the Intruder tab in Burp UI.",
      },
      insertion_points: {
        type: "array",
        description:
          "Byte-offset ranges in the raw request where payloads should be inserted. " +
          "Each element has start and end offsets.",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Start byte offset (inclusive)" },
            end: { type: "number", description: "End byte offset (exclusive)" },
          },
          required: ["start", "end"],
        },
      },
    },
    required: ["host", "raw_request"],
  },
  checkReady: burpNotReady,
  timeoutMs: 30_000,
  shouldRequireConsent(args, ctx) {
    return rawRequestSafetyDetail(args, ctx) !== undefined;
  },
  describeSafety(args, ctx) {
    return rawRequestSafetyDetail(args, ctx);
  },
  async execute(args, _ctx) {
    const { host, raw_request, tab_name } = args;
    const port = args.port ?? 443;
    const secure = args.secure ?? true;
    const insertionPoints = (args.insertion_points || []).map((p: any) => ({
      startOffset: p.start,
      endOffset: p.end,
    }));

    if (!host) return { output: "Error: host is required", exitCode: 1 };
    if (!raw_request) return { output: "Error: raw_request is required", exitCode: 1 };

    const result = await withBurpClient(async (burp) => {
      const b64 = await encodeBurpBody(normalizeHttpRequest(raw_request));

      await burp.intruder.sendToIntruder(
        host,
        port,
        secure,
        b64,
        tab_name || "",
        insertionPoints
      );

      return (
        `Request sent to Burp Intruder for ${host}:${port}${tab_name ? ` (tab: "${tab_name}")` : ""}. ` +
        `${insertionPoints.length} insertion point(s) configured.`
      );
    });

    if (!result.ok) {
      return { output: burpFailureToToolOutput(result, "sending to Intruder"), exitCode: 1 };
    }

    return { output: result.value, exitCode: 0 };
  },
};

export default burpIntruder;
