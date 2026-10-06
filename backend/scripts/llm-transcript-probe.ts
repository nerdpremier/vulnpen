/**
 * Replay the session's REAL transcript through the provider, then bisect to
 * find the exact message the upstream rejects with 400 "Provider returned
 * error".
 */
import mongoose from "mongoose";
import getSecrets from "../src/utils/getSecrets";
import SessionsModel from "../src/models/Sessions/Sessions.model";
import { resolveOrchestrator } from "../src/utils/llm/orchestrator";
import { invoke_llm } from "../src/utils/llm/invoke";
import { messagesToOpenAI } from "../src/services/context.service";

async function main() {
  const MONGO_URI = await getSecrets("MONGO_URI");
  await mongoose.connect(MONGO_URI);
  const sessionId = process.argv[2] ?? "8acaef78-c48f-4c49-9faa-6cb7351d25aa";
  const session = await SessionsModel.findOne({ sessionId }).select("uid messages").lean();
  const userId = String(session!.uid);
  const { config, reasoningMode } = await resolveOrchestrator(userId);
  const docs = (session!.messages ?? []) as any[];
  console.log(`[probe] transcript messages=${docs.length} model=${config.model}`);

  const openai = messagesToOpenAI(docs, config.provider === "kimi");
  console.log(`[probe] openai messages=${openai.length}`);

  const tryRange = async (label: string, msgs: any[]) => {
    try {
      await invoke_llm({
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        providerOverride: config,
        reasoningMode,
        userId,
      });
      console.log(`${label} → ok (control)`);
    } catch {
      console.log(`${label} → FAIL (control?! provider flaky)`);
      return;
    }
    try {
      await invoke_llm({
        messages: msgs as any,
        providerOverride: config,
        reasoningMode,
        userId,
      });
      console.log(`${label} → ok`);
    } catch (err: any) {
      console.log(`${label} → FAIL status=${err?.status} message=${err?.message} body=${JSON.stringify(err?.error ?? err?.response?.data ?? null).slice(0, 300)}`);
    }
  };

  await tryRange("FULL transcript", openai);

  // bisect: find the smallest prefix that fails
  let lo = 1, hi = openai.length, firstBad = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    // ensure we don't cut a tool message away from its parent: snap prefix to
    // end on a user/assistant message
    let cut = mid;
    while (cut < openai.length && openai[cut].role === "tool") cut += 1;
    let ok = true;
    try {
      await invoke_llm({ messages: openai.slice(0, cut) as any, providerOverride: config, reasoningMode, userId });
    } catch (err: any) {
      ok = false;
    }
    if (ok) { lo = cut + 1; } else { firstBad = cut; hi = mid - 1; }
  }
  console.log(`[probe] smallest failing prefix ends at message index ${firstBad}`);
  if (firstBad > 0) {
    const ctx = openai.slice(Math.max(0, firstBad - 4), firstBad);
    for (const m of ctx) {
      console.log(`  - role=${m.role} content=${JSON.stringify(String(m.content ?? "")).slice(0, 120)} toolCalls=${m.tool_calls?.length ?? 0} toolCallId=${m.tool_call_id ?? "-"}`);
    }
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
