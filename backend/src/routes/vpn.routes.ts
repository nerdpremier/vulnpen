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

const router = express.Router();

router.post("/vpn/profiles/upload", [verifySess, uploadOpenVPNMiddleware.array("files", 16)], uploadVPNProfile);
router.get("/vpn/profiles", [verifySess], listVPNProfiles);
router.post("/vpn/profiles/delete", [verifySess], deleteVPNProfile);
router.post("/vpn/connect", [verifySess], connectVPNProfile);
router.post("/vpn/disconnect", [verifySess], disconnectVPNConnection);
router.post("/vpn/disconnect-all", [verifySess], disconnectAllVPN);
router.post("/vpn/status", [verifySess], getVPNStatus);

export { router as vpnRoutes };
