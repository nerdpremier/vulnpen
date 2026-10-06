/**
 * One-shot probe for the orchestrator's LLM provider: resolves the real
 * config the agent loop uses and makes a tiny completion, printing the FULL
 * provider error (status + body) instead of the loop's one-line message.
 * Run: npx tsx scripts/llm-error-probe.ts
 */
import mongoose from "mongoose";
import getSecrets from "../src/utils/getSecrets";
import SessionsModel from "../src/models/Sessions/Sessions.model";
import { resolveOrchestrator } from "../src/utils/llm/orchestrator";
import { invoke_llm } from "../src/utils/llm/invoke";

async function main() {
  const MONGO_URI = await getSecrets("MONGO_URI");
  await mongoose.connect(MONGO_URI);

  const sessionId = process.argv[2] ?? "8acaef78-c48f-4c49-9faa-6cb7351d25aa";
  const session = await SessionsModel.findOne({ sessionId }).select("uid").lean();
  if (!session) throw new Error("session not found: " + sessionId);
  const userId = String(session.uid);

  const { config, reasoningMode } = await resolveOrchestrator(userId);
  console.log(
    `[probe] provider=${config.provider} model=${config.model} baseURL=${config.baseURL ?? "(default)"} auth=${config.authMethod ?? "api_key"} reasoning=${reasoningMode}`,
  );

  try {
    const result = await invoke_llm({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      providerOverride: config,
      reasoningMode,
      userId,
    });
    console.log(`[probe] SUCCESS content=${JSON.stringify(result.content?.slice(0, 120))}`);
  } catch (err: any) {
    console.error("[probe] FAILED");
    console.error("status:", err?.status);
    console.error("message:", err?.message);
    const body = err?.error ?? err?.response?.data ?? err?.body;
    if (body) console.error("body:", JSON.stringify(body, null, 2).slice(0, 3000));
    else console.error(String(err?.stack ?? err).slice(0, 2000));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
