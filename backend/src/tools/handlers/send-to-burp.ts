import { ToolDefinition } from "../types";
import {
  burpNotReady,
  burpFailureToToolOutput,
  sendRawHttpRequest,
  withBurpClient,
} from "../../services/burp-client.service";
import { rawRequestSafetyDetail } from "../../utils/consentDetail";

const MAX_RESPONSE_LENGTH = 8000;

const sendToBurp: ToolDefinition = {
  name: "send_to_burp_repeater",
  description:
    "Send an HTTP request through Burp Suite's Repeater and return the full HTTP response. " +
    "Use this for precision testing of web endpoints — crafting custom payloads, modifying " +
    "headers, testing authentication bypasses, logical flaws, parameter tampering, injection " +
    "payloads (SQLi, XSS, IDOR, SSRF, etc.), and analyzing the raw response in detail. " +
    "Each request is sent individually through Burp's HTTP engine which handles TLS, HTTP/2, " +
    "and connection management. Provide a complete raw HTTP request (request line + headers + body). " +
    "The tool automatically normalizes line endings and recalculates Content-Length. " +
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
        description:
          "Full raw HTTP request including request line, headers, and body. " +
          "Keep original headers (Host, Cookie, Authorization) unless intentionally dropping them. " +
          "Example: 'GET /api/users HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n'",
      },
    },
    required: ["host", "raw_request"],
  },
  checkReady: burpNotReady,
  timeoutMs: 60_000,
  describeSafety(args, ctx) {
    return rawRequestSafetyDetail(args, ctx);
  },
  async execute(args, _ctx) {
    const { host, raw_request } = args;
    const port = args.port ?? 443;
    const secure = args.secure ?? true;

    if (!host) return { output: "Error: host is required", exitCode: 1 };
    if (!raw_request) return { output: "Error: raw_request is required", exitCode: 1 };

    const result = await withBurpClient((burp) =>
      sendRawHttpRequest(burp, { host, port, secure, rawRequest: raw_request })
    );

    if (!result.ok) {
      return { output: burpFailureToToolOutput(result, "sending request through Burp"), exitCode: 1 };
    }

    if (!result.value.rawResponse) {
      return {
        output: "No response received from target. The server may have closed the connection.",
        exitCode: 1,
      };
    }

    let rawResponse = result.value.rawResponse;
    if (rawResponse.length > MAX_RESPONSE_LENGTH) {
      rawResponse =
        rawResponse.substring(0, MAX_RESPONSE_LENGTH) +
        `\n\n... [response truncated — ${rawResponse.length} bytes total]`;
    }

    return { output: rawResponse, exitCode: 0 };
  },
};

export default sendToBurp;
