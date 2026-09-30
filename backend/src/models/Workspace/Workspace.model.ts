import mongoose from "mongoose";

const Schema = mongoose.Schema;

export type WorkspaceType = "pentest" | "general";
export type WorkHostKind = "local" | "ssh";

export interface WorkHostDoc {
  kind: WorkHostKind;
  workFolder: string;
  sshProfileAlias?: string;
  configuredAt: Date;
}

export interface WorkspaceDoc extends mongoose.Document {
  uid: mongoose.Types.ObjectId;
  workspaceId: string;
  name: string;
  description: string;
  type: WorkspaceType;
  createdAt: Date;
  status: "active" | "archived";
  workHost?: WorkHostDoc;
}

const WorkspaceSchema = new Schema({
  uid: { type: mongoose.Types.ObjectId, required: true },
  workspaceId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String, default: "" },
  type: { type: String, default: "general", enum: ["pentest", "general"] },
  createdAt: { type: Date, default: Date.now },
  status: { type: String, default: "active", enum: ["active", "archived"] },
  workHost: {
    type: {
      kind: { type: String, required: true, enum: ["local", "ssh"] },
      workFolder: { type: String, required: true },
      // Only the public ~/.ssh/config alias is persisted. Credentials remain in
      // the SSH agent/config/key mounts owned by the runtime.
      sshProfileAlias: { type: String },
      configuredAt: { type: Date, default: Date.now },
    },
    default: undefined,
  },
});

WorkspaceSchema.index({ uid: 1, status: 1 });
WorkspaceSchema.index({ workspaceId: 1 }, { unique: true });

export default mongoose.model<WorkspaceDoc>("Workspace", WorkspaceSchema);
