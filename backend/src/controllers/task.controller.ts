import { Response, Request } from "express";
import ServiceTaskModel from "../models/ServiceTask/ServiceTask.model";
import SessionsModel from "../models/Sessions/Sessions.model";
import { requireActiveSession } from "../services/session.helpers";
import { resolveSessionWorkHost, testWorkHost } from "../services/work-host.service";

export const startupNewTask = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        message: "Invalid session ID",
      });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (!session.workspaceId) {
      return res.status(409).json({
        success: false,
        message: "This session has not been migrated to a workspace",
      });
    }

    try {
      const target = await resolveSessionWorkHost(sessionId);
      const probe = await testWorkHost(target);
      const connected = probe.code === 0;
      return res.status(200).json({
        success: connected,
        message: connected
          ? `${target.kind === "ssh" ? "SSH" : "Local"} work host is connected`
          : probe.stderr || "Work host is not connected",
        status: connected ? "running" : "disconnected",
        readyToConnect: connected,
        containerIP: target.kind === "ssh"
          ? target.sshProfile?.host || target.sshProfileAlias
          : "localhost",
        type: target.kind,
        workFolder: probe.stdout.trim() || target.workFolder,
      });
    } catch (error: any) {
      return res.status(200).json({
        success: false,
        message: error?.message || "Work host is not connected",
        status: "disconnected",
        readyToConnect: false,
      });
    }
  } catch (err: any) {
    console.log(err);
    return res.status(400).json({
      message: "Failed to start exploit box, please try again later",
    });
  }
};

export const exploitBoxStatus = async (req: Request, res: Response) => {
  const userId = res.locals.userId;

  const { sessionId } = req.params;

  try {
    if (!sessionId) {
      return res.status(400).json({
        message: "Invalid session ID",
      });
    }

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;
    if (!session.workspaceId) {
      return res.status(409).json({
        message: "This session has not been migrated to a workspace",
        success: false,
      });
    }

    const target = await resolveSessionWorkHost(sessionId);
    const probe = await testWorkHost(target);
    const connected = probe.code === 0;
    return res.status(200).json({
      success: connected,
      message: connected
        ? `${target.kind === "ssh" ? "SSH" : "Local"} work host is connected`
        : probe.stderr || "Work host is not connected",
      status: connected ? "running" : "disconnected",
      readyToConnect: connected,
      containerIP: target.kind === "ssh"
        ? target.sshProfile?.host || target.sshProfileAlias
        : "localhost",
      type: target.kind,
      workFolder: probe.stdout.trim() || target.workFolder,
    });
  } catch (err: any) {
    console.log("Failed to check exploit box status:", err.message);
    return res.status(400).json({
      message: "Task not found",
      success: false,
    });
  }
};

export const extendTaskExpiration = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;

    const { serviceId } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        message: "Service not found",
      });
    }

    const serviceTask = await ServiceTaskModel.findOne({
      serviceId,
      uid: userId,
      status: { $ne: "stopped" },
    });

    if (!serviceTask) {
      return res.status(400).json({
        message: "Task not found",
      });
    }

    if (serviceTask.extends >= 3) {
      return res.status(400).json({
        message: "Maximum extension limit reached",
      });
    }

    const session = await SessionsModel.findOne({
      uid: userId,
      boxId: serviceTask._id,
    });

    if (!session) {
      return res.status(400).json({
        message: "Session not found",
      });
    }

    // expiresAt + 30 minutes
    serviceTask.expiresAt = new Date(
      serviceTask.expiresAt.getTime() + 30 * 60 * 1000
    );

    serviceTask.extends = serviceTask.extends + 1;

    await serviceTask.save();

    return res.status(200).json({
      message: "Task expiration extended successfully!",
      success: true,
      extends: serviceTask.extends,
      expiresAt: serviceTask.expiresAt,
    });
  } catch {
    return res.status(400).json({
      message: "Failed to extend task expiration",
      success: false,
    });
  }
};
