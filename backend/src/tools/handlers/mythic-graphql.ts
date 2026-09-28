import { ToolDefinition } from "../types";
import {
  MYTHIC_NOT_CONFIGURED_MSG,
  describeMythicError,
  isMythicConfigured,
  mythicGraphql,
} from "../../services/mythic.client";

/** Detect top-level GraphQL mutation operations without matching comments or strings. */
export function isMythicGraphqlMutation(source: string): boolean {
  let depth = 0;
  let atDefinitionStart = true;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === "#") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
      continue;
    }
    if (source.startsWith('"""', index)) {
      index += 3;
      while (index < source.length && !source.startsWith('"""', index)) index++;
      index += source.startsWith('"""', index) ? 3 : 0;
      continue;
    }
    if (char === '"') {
      index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index++] === '"') break;
      }
      continue;
    }
    if (char === "{") {
      depth++;
      atDefinitionStart = false;
      index++;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) atDefinitionStart = true;
      index++;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const start = index++;
      while (index < source.length && /[_0-9A-Za-z]/.test(source[index])) index++;
      if (depth === 0 && atDefinitionStart) {
        atDefinitionStart = false;
        if (source.slice(start, index) === "mutation") return true;
      }
      continue;
    }
    index++;
  }
  return false;
}

/**
 * Escape hatch onto Mythic's raw GraphQL API.
 *
 * Mythic's schema varies by version and by which agents and C2 profiles the operator
 * has installed, and Mythic does not publish a stable operation list. When one of the
 * purpose-built tools fails because a field or action was renamed, the agent can
 * introspect the live schema here and adapt instead of dead-ending.
 */
const mythicGraphqlTool: ToolDefinition = {
  name: "mythic_graphql",
  description:
    "Run a raw GraphQL query against the operator's Mythic C2 server. This is an escape hatch — prefer " +
    "mythic_callbacks, mythic_task, mythic_pivot, mythic_payload, mythic_listener and mythic_loot, which cover " +
    "the common workflows. Use this when one of those fails with a schema error (Mythic's schema varies by " +
    "version and installed agents), or to reach a table they do not expose. Introspect with " +
    '`{ __schema { queryType { fields { name } } } }` to discover what this server actually supports. ' +
    "Operates against the operator's Mythic server; all C2 session data remains in Mythic, this tool only issues API calls.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The GraphQL document to execute against Mythic's /graphql endpoint.",
      },
      variables: {
        type: "string",
        description: "Optional JSON string of GraphQL variables.",
      },
    },
    required: ["query"],
  },
  timeoutMs: 60_000,
  shouldRequireConsent(args) {
    // A raw mutation can do anything an operator can. Always an explicit decision,
    // and never something a subagent or racer runs unattended.
    return isMythicGraphqlMutation(String(args?.query || ""));
  },
  async execute(args, _ctx) {
    if (!isMythicConfigured()) {
      return { output: `Error: ${MYTHIC_NOT_CONFIGURED_MSG}`, exitCode: 1 };
    }

    const query = String(args.query || "").trim();
    if (!query) {
      return { output: "Error: query is required.", exitCode: 1 };
    }

    let variables: Record<string, any> = {};
    if (typeof args.variables === "string" && args.variables.trim()) {
      try {
        variables = JSON.parse(args.variables);
      } catch (err: any) {
        return { output: `Error: variables is not valid JSON: ${err.message}`, exitCode: 1 };
      }
    }

    try {
      const data = await mythicGraphql(query, variables);
      return { output: JSON.stringify(data, null, 2), exitCode: 0 };
    } catch (err) {
      return { output: `Error: ${describeMythicError(err)}`, exitCode: 1 };
    }
  },
};

export default mythicGraphqlTool;
