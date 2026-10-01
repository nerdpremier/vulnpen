import express from "express";
import { verifySess } from "../middlewares/VerifySession.middleware";
import {
  uploadVPNProfile,
  listVPNProfiles,
  deleteVPNProfile,
  connectVPNProfile,
  disconnectVPNConnection,
  disconnectAllVPN,
  getVPNStatus,
} from "../controllers/vpn.controller";
import { uploadOpenVPNMiddleware } from "../middlewares/MulterMiddleware";
import { requireHostOwner } from "../services/host-owner.service";

const router = express.Router();

// Profiles live on the shared attack box (host-level resource, like the SSH
// config), so mutating the shared profile store is owner-only. Connecting a
// profile stays available to every account through its own uid-scoped session.
router.post("/vpn/profiles/upload", [verifySess, requireHostOwner, uploadOpenVPNMiddleware.array("files", 16)], uploadVPNProfile);
router.get("/vpn/profiles", [verifySess], listVPNProfiles);
router.post("/vpn/profiles/delete", [verifySess, requireHostOwner], deleteVPNProfile);
router.post("/vpn/connect", [verifySess], connectVPNProfile);
router.post("/vpn/disconnect", [verifySess], disconnectVPNConnection);
router.post("/vpn/disconnect-all", [verifySess], disconnectAllVPN);
router.post("/vpn/status", [verifySess], getVPNStatus);

export { router as vpnRoutes };
