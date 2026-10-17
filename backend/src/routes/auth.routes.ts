import express from "express";
import {
  changePassword,
  checkUserSession,
  getRegistrationStatus,
  loginUser,
  logout,
  registerUser,
  resetPassword,
} from "../controllers/auth.controller";
import { verifySess } from "../middlewares/VerifySession.middleware";
const router = express.Router();

router.post("/login", loginUser);
router.post("/register", registerUser);
router.get("/registration-status", getRegistrationStatus);
router.post("/logout", logout);
router.get("/status", checkUserSession);
router.post("/change-password", [verifySess], changePassword);
// Public: the caller is locked out by definition and proves it with the email
// address alone. See the handler for what that means for exposure.
router.post("/reset-password", resetPassword);

export { router as authRoutes };
