import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import { createClient, RedisClientType } from "redis";
import mongoose from "mongoose";
import { createServer } from "http";
const mongoSanitize = require("express-mongo-sanitize");
import multer from "multer";
import RedisStore from "connect-redis";
import { authRoutes } from "./routes/auth.routes";
import { taskRoutes } from "./routes/task.routes";
import { userRoutes } from "./routes/user.routes";
import { agentRoutes } from "./routes/agent.routes";
import { shellRoutes } from "./routes/shell.routes";
import { vpnRoutes } from "./routes/vpn.routes";
import { vncRoutes } from "./routes/vnc.routes";
import { burpRoutes } from "./routes/burp.routes";
import { workspaceRoutes } from "./routes/workspace.routes";
import getSecrets from "./utils/getSecrets";
import { initTracing } from "./utils/tracing";
import { setupShellWebSocket } from "./services/shell.socket";
import { sessionLifecycle } from "./services/session.lifecycle";
import { migrateSessionsToWorkspaces } from "./migrations/001-create-workspaces";
import { migrateToolExecutionMode } from "./migrations/002-migrate-tool-execution-mode";

declare module "express-session" {
  export interface SessionData {
    user: { userId: string };
    environment: string;
  }
}

let redisClient: RedisClientType;
let startupReady = false;

const initializeApp = async () => {
  try {
    initTracing();

    const DEPLOYMENT = await getSecrets("DEPLOYMENT");
    const BASE_URL_FRONTEND = await getSecrets("BASE_URL_FRONTEND");
    const MONGO_URI = await getSecrets("MONGO_URI");
    const REDIS_URL = await getSecrets("REDIS_URL");
    redisClient = createClient({ url: REDIS_URL });

    const SESS_SECRET = await getSecrets("SESS_SECRET");
    const SESS_LIFETIME = await getSecrets("SESS_LIFETIME");
    const productionDeployment = DEPLOYMENT !== "LOCAL";
    if (productionDeployment) {
      const configuredOrigins = (process.env.CORS_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
      let frontendUrl: URL;
      try {
        frontendUrl = new URL(BASE_URL_FRONTEND);
      } catch {
        throw new Error("Production BASE_URL_FRONTEND must be a valid HTTPS URL");
      }
      if (frontendUrl.protocol !== "https:") {
        throw new Error("Production deployment requires an HTTPS BASE_URL_FRONTEND");
      }
      if (
        configuredOrigins.length === 0 ||
        configuredOrigins.some((origin) => {
          try {
            const parsed = new URL(origin);
            return parsed.protocol !== "https:" || parsed.origin !== origin;
          } catch {
            return true;
          }
        })
      ) {
        throw new Error("Production deployment requires explicit HTTPS CORS_ORIGINS");
      }
      if (!SESS_SECRET || SESS_SECRET.length < 32) {
        throw new Error("Production deployment requires a session secret of at least 32 characters");
      }
    }

    const connectToDB = async () => {
      if (!MONGO_URI) {
        throw new Error("MONGO_URI is not configured");
      }
      await mongoose.connect(MONGO_URI);
    };

    const app = express();
    if (productionDeployment) app.set("trust proxy", 1);
    const port = parseInt(process.env.PORT || "8080", 10);

    const defaultWhitelist = [
      "http://127.0.0.1:8080",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:5000",
      "http://localhost:8080",
      "http://localhost:5000",
      "http://localhost:3001",
      "http://localhost:3000",
    ];

    const corsOriginsEnv = process.env.CORS_ORIGINS;
    const localWhitelist = productionDeployment
      ? corsOriginsEnv!.split(",").map((o) => o.trim()).filter(Boolean)
      : corsOriginsEnv
        ? [
            ...defaultWhitelist,
            ...corsOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean),
          ]
        : defaultWhitelist;

    const corsOptions = {
      origin: localWhitelist,
      allowedHeaders: [
        "Origin",
        "X-Requested-With",
        "Content-Type",
        "Accept",
        "X-Access-Token",
        "Authorization",
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Credentials",
        "Access-Control-Allow-Headers",
        "x-csrf-token",
        "Set-Cookie",
      ],
      credentials: true,
      methods: "GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE",
    };

    app.use(cors(corsOptions));
    app.options("*", cors(corsOptions));

    app.use(
      express.urlencoded({
        extended: true,
      })
    );

    app.use((req, res, next) => {
      express.json({
        limit: "5mb",
        type: ["application/json", "text/plain"],
      })(req, res, (err) => {
        if (err) {
          console.log(err);
          return res.status(400).json({ message: "Invalid JSON" });
        } else {
          next();
        }
      });
    });

    app.use(cookieParser());
    app.use(mongoSanitize());

    // @ts-expect-error connect-redis's client type does not include this Redis client version.
    const redisStore = new RedisStore({ client: redisClient });

    // SESS_LIFETIME is configured in seconds (config.toml [session].lifetime); default 12h.
    const sessionMaxAgeMs =
      Number(SESS_LIFETIME) > 0 ? Number(SESS_LIFETIME) * 1000 : 1000 * 60 * 60 * 12;

    const sessionConfig = {
      secret: SESS_SECRET as string,
      resave: false,
      name: "sid",
      saveUninitialized: false,
      proxy: true,
      store: redisStore,
      cookie: {
        sameSite: true as const,
        secure: DEPLOYMENT === "LOCAL" ? false : true,
        maxAge: sessionMaxAgeMs,
      },
    };

    const sessionMiddleware = session(sessionConfig);
    app.use(sessionMiddleware);

    const httpServer = createServer(app);

    // WebSocket for shell streaming (replaces Socket.IO terminal handling)
    setupShellWebSocket(httpServer, sessionMiddleware);

    app.get("/", (_req, res) => {
      res.send("Hello World!");
    });

    app.get("/api/healthcheck", (_req, res) => {
      const mongoReady = mongoose.connection.readyState === 1;
      const redisReady = redisClient.isReady;
      const ready = mongoReady && redisReady && startupReady;
      return res.status(ready ? 200 : 503).json({
        status: ready ? "ready" : "starting",
        mongodb: mongoReady ? "ready" : "unavailable",
        redis: redisReady ? "ready" : "unavailable",
      });
    });


    // Routes
    app.use("/api/auth", authRoutes);
    app.use("/api/task", taskRoutes);
    app.use("/api/user", userRoutes);
    app.use("/api/agent", agentRoutes);
    app.use("/api/shell", shellRoutes);
    app.use("/api/infra", vpnRoutes);
    app.use("/api/infra", vncRoutes);
    app.use("/api/burp", burpRoutes);
    app.use("/api/workspace", workspaceRoutes);

    app.use(function (err: any, _req: any, res: any, _next: any) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "File size limit exceeded" });
        }
        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({ message: "Unexpected File type or Number of File(s)" });
        }
        return res.status(400).json({ message: "Error occurred uploading file" });
      }
      console.error("Unhandled error:", err);
      const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
      return res.status(status).json({
        message: "Something went wrong, please try again later",
      });
    });

    await Promise.all([connectToDB(), redisClient.connect()]);
    console.log("MongoDB connected");
    console.log("Redis connected");

    const workspaceMigration = await migrateSessionsToWorkspaces();
    const toolModeMigration = await migrateToolExecutionMode(
      mongoose.connection.collection("users"),
    );
    console.log(
      `[startup] Migrations complete: ${workspaceMigration.created} workspace(s), ` +
      `${toolModeMigration.migrated} consent setting(s) migrated`,
    );

    const { default: SessionsModel } = await import("./models/Sessions/Sessions.model");
    const resetResult = await SessionsModel.updateMany(
      { agentState: "running" },
      { $set: { agentState: "idle" } },
    );
    if (resetResult.modifiedCount > 0) {
      console.log(`[startup] Reset ${resetResult.modifiedCount} session(s) from "running" to "idle"`);
    }

    startupReady = true;
    httpServer.listen(port, () => {
      console.log(`Express is listening at http://localhost:${port}`);
    });

    process.on("SIGTERM", async () => {
      console.log("SIGTERM received. Shutting down gracefully...");

      await sessionLifecycle.destroyAll();

      const memoryUsage = process.memoryUsage();
      console.log("Memory Usage:", {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
      });

      httpServer.close(() => {
        console.log("HTTP server closed.");
        process.exit(0);
      });

      // Open SSE/WebSocket connections can keep close() waiting forever —
      // force the exit so containers do not fall back to SIGKILL.
      setTimeout(() => {
        console.log("Graceful shutdown timed out; forcing exit.");
        process.exit(0);
      }, 10_000).unref();
    });
  } catch (error) {
    console.error("Error initializing app", error);
    process.exit(1);
  }
};

initializeApp().catch((error) => {
  console.error("Failed to initialize server:", error);
});

export { redisClient };
