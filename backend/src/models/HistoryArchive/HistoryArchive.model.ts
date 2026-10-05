import mongoose from "mongoose";
const Schema = mongoose.Schema;

/** One archived transcript row, as stored when a session is archived. */
interface ArchiveHistoryData {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  isContextual?: boolean;
  loopStep?: number;
  loop: number;
}

export interface SessionDoc extends mongoose.Document {
  sessionId: string;
  history: ArchiveHistoryData[];
}

const HistoryArchiveSchema = new Schema({
  sessionId: { type: String, required: true },
  history: {
    type: [
      {
        role: { type: String, required: true },
        content: { type: String, required: true },
        isContextual: { type: Boolean },
        loopStep: { type: Number },
        loop: { type: Number },
      },
    ],
  },
});

export default mongoose.model<SessionDoc>(
  "HistoryArchive",
  HistoryArchiveSchema
);
