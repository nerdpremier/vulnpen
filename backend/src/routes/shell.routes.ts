import { Router, Request, Response } from "express";
import { verifySess } from "../middlewares/VerifySession.middleware";
import { requireHostOwner } from "../services/host-owner.service";
import { sessionLifecycle } from "../services/session.lifecycle";
import { requireActiveSession } from "../services/session.helpers";
import WorkspaceModel from "../models/Workspace/Workspace.model";
import { execSSHCommand } from "../services/ssh.service";
import {
  getCapabilityByName,
  getInstallCommandForOS,
} from "../capabilities/registry";
import { buildPrivilegeAwareInstallCommand } from "../utils/installCommand";
import {
  listSSHProfiles,
  resolveSSHProfile,
  testSSHProfile,
} from "../services/ssh-profile.service";
import { defaultWorkFolder } from "../services/work-host.service";

const router = Router();

router.use(verifySess);

const SSH_TEST_TIMEOUT_MS = 5000;

router.post("/test-ssh", async (_req: Request, res: Response) => {
  try {
    const whoami = await execSSHCommand("whoami", SSH_TEST_TIMEOUT_MS);
    return res.status(200).json({
      success: true,
      message: `SSH connected as ${whoami.trim()}`,
    });
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      message: err.message || "SSH connection failed",
    });
  }
});

/**
 * Install a capability on the SSH box directly, without depending on the
 * session's work-host kind. The shared cap install path (capabilities.service)
 * resolves through the session ShellManager, whose target here is a *local*
 * Windows folder — so installs were landing on the dev machine instead of the
 * Kali box. Detection (detect-capabilities) had always talked to the box via
 * ssh.service, so installing through the same ssh.service keeps installs and
 * detection on the same host.
 *
 * That host is the installation's shared attack box (ssh.service resolves its
 * target from the installation SSH config, not from the caller's own work host),
 * so the install is owner-only: a non-owner member must not add software to
 * infrastructure other users' sessions execute against.
 */
router.post("/install-capability", requireHostOwner, async (req: Request, res: Response) => {
  try {
    const capabilityName = String(req.body?.capabilityName || "").trim();
    if (!capabilityName) {
      return res.status(400).json({ message: "capabilityName is required" });
    }
    const cap = getCapabilityByName(capabilityName);
    if (!cap) {
      return res.status(400).json({ message: `Unknown capability: "${capabilityName}"` });
    }

    const unameOutput = await execSSHCommand("uname -s", 10_000);
    const isDarwin = unameOutput.trim().includes("Darwin");
    const installCommand = buildPrivilegeAwareInstallCommand(
      getInstallCommandForOS(cap, isDarwin),
      isDarwin,
    );

    const output = await execSSHCommand(installCommand, 600_000);
    const ok = !/^\s*(error|failed|no such)/i.test(output.trim()) && !/[Tt]raceback/.test(output);
    return res.status(200).json({
      success: ok,
      output,
      message: ok ? `${cap.label} installed successfully` : (output.trim() || "Install command exited with an error"),
    });
  } catch (err: any) {
    return res.status(400).json({ message: err?.message ?? "Install failed" });
  }
});

router.get("/:sessionId/ssh-profiles", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const workspace = await WorkspaceModel.findOne({ workspaceId: session.workspaceId, uid: userId }).lean();
    const profiles = await listSSHProfiles();
    return res.status(200).json({
      profiles,
      selectedAlias: workspace?.workHost?.kind === "ssh" ? workspace.workHost.sshProfileAlias ?? null : null,
      connectionState: session.connectionState ?? { sshConnected: false, hostConnected: false },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message || "Failed to discover SSH profiles" });
  }
});

router.post("/:sessionId/ssh-profile/test", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const profileAlias = String(
      req.body?.profileAlias || "",
    ).trim();
    if (!profileAlias) {
      return res.status(400).json({ message: "Select an SSH profile first" });
    }
    const profile = await testSSHProfile(profileAlias);
    return res.status(200).json({ success: true, profile });
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      message: err.message || "SSH connection failed",
    });
  }
});

router.put("/:sessionId/ssh-profile", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const profileAlias = String(req.body?.profileAlias || "").trim();
    if (!profileAlias) {
      return res.status(400).json({ message: "profileAlias is required" });
    }
    const resolved = await resolveSSHProfile(profileAlias);
    if (!resolved.summary.available) {
      return res.status(400).json({ message: resolved.summary.error || "SSH profile is unavailable" });
    }

    await WorkspaceModel.updateOne(
      { workspaceId: session.workspaceId, uid: userId, status: "active" },
      { $set: { workHost: {
        kind: "ssh",
        workFolder: req.body?.workFolder || defaultWorkFolder(session.workspaceId),
        sshProfileAlias: profileAlias,
        configuredAt: new Date(),
      } } },
    );
    session.connectionState = { sshConnected: false, hostConnected: false };
    await session.save();

    await sessionLifecycle.destroy(sessionId);
    const manager = await sessionLifecycle.getShellManager(sessionId);
    try {
      await manager.connect();
      return res.status(200).json({
        message: `Connected with ${profileAlias}`,
        profile: resolved.summary,
        sshConnected: true,
      });
    } catch (error: any) {
      return res.status(200).json({
        message: error?.message || "Profile saved, but SSH connection failed",
        profile: resolved.summary,
        sshConnected: false,
      });
    }
  } catch (err: any) {
    return res.status(400).json({ message: err.message || "Failed to save SSH profile" });
  }
});

router.delete("/:sessionId/ssh-profile", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    await sessionLifecycle.destroy(sessionId);
    await WorkspaceModel.updateOne(
      { workspaceId: session.workspaceId, uid: userId, status: "active" },
      { $unset: { workHost: "" } },
    );
    session.connectionState = { sshConnected: false, hostConnected: false };
    await session.save();
    return res.status(200).json({ message: "SSH profile disconnected" });
  } catch (err: any) {
    return res.status(500).json({ message: err.message || "Failed to disconnect SSH profile" });
  }
});

router.get("/:sessionId/list", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (sessionLifecycle.hasShellManager(sessionId)) {
      const mgr = await sessionLifecycle.getShellManager(sessionId);
      return res.status(200).json({ shells: mgr.getShellList() });
    }

    return res.status(200).json({ shells: session.shells ?? [] });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/:sessionId/:shellId/buffer", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, shellId } = req.params;
    const fromOffset = req.query.fromOffset ? parseInt(req.query.fromOffset as string, 10) : undefined;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const mgr = await sessionLifecycle.getShellManager(sessionId);
    const { data, offset } = mgr.readOutput(shellId, fromOffset);
    return res.status(200).json({ data, offset });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.post("/:sessionId/spawn", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;
    const { label } = req.body;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (!label) {
      return res.status(400).json({ message: "label is required" });
    }

    const mgr = await sessionLifecycle.ensureShellManager(sessionId, { required: true });

    const shellId = await mgr.spawnShell({ label, type: "pty", createdBy: "user" });
    return res.status(200).json({ shellId, label });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.delete("/:sessionId/:shellId", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId, shellId } = req.params;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const mgr = await sessionLifecycle.getShellManager(sessionId);
    await mgr.closeShell(shellId);
    return res.status(200).json({ message: "Shell closed" });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/:sessionId/connection", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    if (sessionLifecycle.hasShellManager(sessionId)) {
      const mgr = await sessionLifecycle.getShellManager(sessionId);
      const state = session.connectionState ?? {};
      return res.status(200).json({
        ...state,
        sshConnected: mgr.isConnected,
      });
    }

    return res.status(200).json(session.connectionState ?? { sshConnected: false });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.post("/:sessionId/reconnect", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.userId;
    const { sessionId } = req.params;

    const session = await requireActiveSession(userId, sessionId, res);
    if (!session) return;

    const mgr = await sessionLifecycle.getShellManager(sessionId);
    await mgr.reconnect();
    return res.status(200).json({ message: "Reconnected", sshConnected: true });
  } catch (err: any) {
    return res.status(500).json({ message: `Reconnect failed: ${err.message}` });
  }
});

export const shellRoutes = router;
