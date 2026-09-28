import express from "express";
import {
  checkUserSession,
  getRegistrationStatus,
  loginUser,
  logout,
  registerUser,
} from "../controllers/auth.controller";
const router = express.Router();

router.post("/login", loginUser);
router.post("/register", registerUser);
router.get("/registration-status", getRegistrationStatus);
router.post("/logout", logout);
router.get("/status", checkUserSession);

export { router as authRoutes };
