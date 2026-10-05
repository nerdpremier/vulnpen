import { ToolDefinition } from "../types";
import { burpFailureToToolOutput, withBurpClient } from "../../services/burp-client.service";

const burpCollaborator: ToolDefinition = {
  name: "burp_collaborator",
  description:
    "Interact with Burp Collaborator for out-of-band (OOB) testing. " +
    'Use action "generate" to create a Collaborator payload domain that can be injected ' +
    "into requests to detect blind SSRF, XXE, blind SQL injection, or other OOB vulnerabilities. " +
    'Use action "poll" with the secret key returned from generate to check for DNS/HTTP/SMTP ' +
    "interactions that occurred against the payload.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["generate", "poll"],
        description: '"generate" creates a new Collaborator payload, "poll" checks for interactions.',
      },
      secret_key: {
        type: "string",
        description: 'Required for "poll" action. The secret key returned from a previous "generate" call.',
      },
      custom_data: {
        type: "string",
        description: 'Optional data to embed in the payload (max 16 alphanumeric chars). Only used with "generate".',
      },
    },
    required: ["action"],
  },
  timeoutMs: 30_000,
  async execute(args, _ctx) {
    const { action, secret_key, custom_data } = args;

    if (action === "poll" && !secret_key) {
      return { output: 'Error: secret_key is required for "poll" action.', exitCode: 1 };
    }

    const result = await withBurpClient(async (burp) => {
      if (action === "generate") {
        const payload = await burp.collaborator.generatePayload(custom_data || "");
        return {
          output:
            `Collaborator payload generated:\n` +
            `  Payload: ${payload.payload}\n` +
            `  Server:  ${payload.server}\n` +
            `  Secret Key: ${payload.secretKey}\n\n` +
            `Inject this payload into requests and then poll with the secret key to check for interactions.`,
          exitCode: 0 as const,
        };
      }

      if (action === "poll") {
        const interactions = await burp.collaborator.poll(secret_key);

        if (interactions.length === 0) {
          return {
            output: "No Collaborator interactions found. The payload may not have been triggered yet.",
            exitCode: 0 as const,
          };
        }

        const lines = interactions.map(
          (i: any, idx: number) =>
            `[${idx + 1}] ${i.type} interaction from ${i.clientIp}:${i.clientPort} at ${i.timestamp}` +
            (i.customData ? ` (custom: ${i.customData})` : "")
        );

        return {
          output: `Found ${interactions.length} Collaborator interaction(s):\n${lines.join("\n")}`,
          exitCode: 0 as const,
        };
      }

      return { output: `Error: Unknown action "${action}". Use "generate" or "poll".`, exitCode: 1 as const };
    });

    if (!result.ok) {
      return { output: burpFailureToToolOutput(result, "with Collaborator"), exitCode: 1 };
    }

    return result.value;
  },
};

export default burpCollaborator;
