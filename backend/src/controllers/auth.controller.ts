import { Request, Response } from "express";
import UserModel from "../models/User/User.model";
import { readEnvFile } from "../utils/envWriter";
import { createRateLimiter } from "../utils/rateLimiter";
import {
  readAllowRegistrationFlag,
  resolveRegistrationPolicy,
} from "../utils/registrationPolicy";

import bcrypt from "bcrypt";
import geoip from "geoip-lite";

export const logout = async (req: Request, res: Response) => {
  try {
    const user = req.session.user;
    if (!user) {
      // No user in session, can't perform logout
      return res.status(400).json({ message: "No user to log out!" });
    }

    // Destroy the session and clear the cookie
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destruction error:", err);
        return res.status(500).json({ message: "Error logging out!" });
      }
      res.clearCookie("sid");
      // Moved the success response here to ensure it's called after session is destroyed
      res.status(200).json({ message: "Logged out successfully!" });
    });
  } catch (err) {
    console.error("Logout error:", err);
    // Sending a 500 status code for server-side errors
    return res.status(500).json({ message: "Failed to logout!" });
  }
};

export const checkUserSession = async (req: Request, res: Response) => {
  try {
    const { user } = req.session;
    if (user == null)
      return res.status(400).json({
        success: false,
        message: "Invalid session!",
      });

    if (req.session.user != null) {
      const u = await UserModel.findOne({ _id: user.userId });

      if (u == null) {
        return res.status(400).json({
          success: false,
          message: "User not found!",
        });
      }


      // const secretKey = await getSecrets("INTERCOM-SECRET"); // secret key (keep safe!)
      // const userIdentifier = u.email; // user's email address

      // const hash = crypto
      //   .createHmac("sha256", secretKey)
      //   .update(userIdentifier)
      //   .digest("hex");

      return res.status(200).json({
        success: true,
        user: {
          name: u.name,
          email: u.email,
          firstLogin: u.firstLogin,
          profilePicture: u.profilePicture,
          uid: u._id,
        },
      });
    }

    return res.status(400).json({
      message: "Session not found!",
    });
  } catch (err) {
    console.log(err);
    return res.status(400).json({ message: "Session not found!" });
  }
};


export const registerUser = async (req: Request, res: Response) => {
  try {
    const registerIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (registerRateLimited(registerIp)) {
      return res.status(429).json({ message: "Too many registration attempts, please try again later" });
    }

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const existingUsers = await UserModel.estimatedDocumentCount();
    const policy = resolveRegistrationPolicy({
      existingUsers,
      allowRegistration: readAllowRegistrationFlag(readEnvFile()),
    });
    if (!policy.open) {
      return res.status(403).json({
        message:
          "Registration is closed on this installation. Sign in with an existing account, or set ALLOW_REGISTRATION=true to reopen it.",
      });
    }

    let user = await UserModel.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    user = new UserModel({
      name,
      email,
      password: hashedPassword,
      // The first account owns the installation; later accounts are members.
      installationId: policy.bootstrap ? "installation-owner" : undefined,
    });

    await user.save();

    return res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    console.error("Error registering user:", error);
    if ((error as any)?.code === 11000) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getRegistrationStatus = async (_req: Request, res: Response) => {
  try {
    const existingUsers = await UserModel.estimatedDocumentCount();
    const policy = resolveRegistrationPolicy({
      existingUsers,
      allowRegistration: readAllowRegistrationFlag(readEnvFile()),
    });
    return res.status(200).json({
      registrationOpen: policy.open,
      bootstrap: policy.bootstrap,
      reason: policy.reason,
      existingUsers,
    });
  } catch (err) {
    console.error("Error reading registration status:", err);
    return res.status(500).json({ message: "Failed to read registration status" });
  }
};

const loginRateLimited = createRateLimiter(10, 15 * 60 * 1000);
const registerRateLimited = createRateLimiter(10, 60 * 60 * 1000);

export const loginUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // req.ip honors X-Forwarded-For only when the app trusts a proxy (PROD); in LOCAL
    // mode a spoofed header cannot influence the limiter or the stored IP.
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (loginRateLimited(clientIp)) {
      return res.status(429).json({ message: "Too many login attempts, please try again later" });
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Account-level lockout: survive IP rotation where per-IP throttling cannot.
    // Partial updates on the lockout fields avoid running validators on legacy documents.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(429).json({
        message: "Account temporarily locked due to repeated failed logins",
        until: user.lockedUntil,
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      // Linear ramp after the configured cap: 10 failures => lockedMinutes = 5 + 5*5 = 30m; default 5m first lock.
      const failed = (user.failedLoginCount ?? 0) + 1;
      const update: Record<string, any> = { failedLoginCount: failed };
      const LOCK_THRESHOLD = 10;
      if (failed >= LOCK_THRESHOLD) {
        const lockMinutes = Math.min(60 * 24, 5 * Math.floor(failed / LOCK_THRESHOLD) * 5);
        update.lockedUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
      }
      await UserModel.updateOne({ _id: user._id }, { $set: update });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Reset on success and update geo/ip as before.
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { failedLoginCount: 0, lockedUntil: null, ip: clientIp } },
    );
    const ip = clientIp;
    user.ip = ip;
    const geo = geoip.lookup(ip);

    if (geo) {
      user.ipLocation = {
        ...geo,
        ip: ip,
      };
    }

    await user.save();

    req.session.user = {
      userId: user._id.toString(),
    };

    // saving the session — the response must wait so the client never holds a
    // cookie the store has not persisted yet.
    await new Promise<void>((resolve) => {
      req.session.save((err) => {
        if (err) console.error("Failed to save session:", err);
        resolve();
      });
    });
    if (!req.session.user) {
      return res.status(500).json({ message: "Failed to save session!" });
    }

    return res.status(200).json({
      message: "User logged in successfully",
      user: {
        uid: user._id,
        name: user.name,
        email: user.email,
        profilePicture: user.profilePicture,
      },
    });

  } catch (error) {
    console.error("Error logging in user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
