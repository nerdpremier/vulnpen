/** Offline check: every tool-call argument messagesToOpenAI renders for the
 *  real transcript must be valid JSON — the exact shape Novita rejected. */
import mongoose from "mongoose";
import getSecrets from "../src/utils/getSecrets";
import SessionsModel from "../src/models/Sessions/Sessions.model";
import { resolveOrchestrator } from "../src/utils/llm/orchestrator";
import { messagesToOpenAI } from "../src/services/context.service";

async function main() {
  const MONGO_URI = await getSecrets("MONGO_URI");
  await mongoose.connect(MONGO_URI);
  const sessionId = process.argv[2] ?? "8acaef78-c48f-4c49-9faa-6cb7351d25aa";
  const session = await SessionsModel.findOne({ sessionId }).select("uid messages").lean();
  const userId = String(session!.uid);
  const { config } = await resolveOrchestrator(userId);
  const openai = messagesToOpenAI((session!.messages ?? []) as any[], config.provider === "kimi");

  let checked = 0, broken = 0;
  openai.forEach((m: any, i: number) => {
    for (const tc of m.tool_calls ?? []) {
      checked += 1;
      try {
        JSON.parse(tc.function.arguments);
      } catch (err: any) {
        broken += 1;
        console.log(`INVALID at msg#${i} tool=${tc.function.name}: ${err.message}`);
        console.log("  args:", tc.function.arguments.slice(0, 200));
      }
    }
  });
  console.log(`checked=${checked} broken=${broken} → ${broken === 0 ? "ALL VALID ✅" : "BROKEN ❌"}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
