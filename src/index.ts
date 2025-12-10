import express, { Request, Response, NextFunction } from "express";
import bodyParser from "body-parser";
import { config } from "./env";
import { webhooks, registerEventHandlers } from "./integrations/github";
import { getRedisClient, closeRedisConnection } from "./redis";

const app = express();
const port = Number(config.PORT) || 3000;

// Track server state for graceful shutdown
let isShuttingDown = false;
let server: ReturnType<typeof app.listen> | null = null;

// Request timeout (30 seconds for most, 120 for webhook processing)
const DEFAULT_TIMEOUT_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 120_000;

// Middleware: reject requests during shutdown
app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.status(503).json({ error: "Server is shutting down" });
    return;
  }
  next();
});

// Middleware: request timeout
app.use((req: Request, res: Response, next: NextFunction) => {
  const timeout = req.path === "/webhook" ? WEBHOOK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  res.setTimeout(timeout, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: "Request timeout" });
    }
  });
  next();
});

// JSON parsing for all routes except /webhook
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/webhook") {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});

// Register GitHub event handlers
registerEventHandlers();

// Health check endpoint
app.get("/health", async (_req: Request, res: Response) => {
  const health: {
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: string;
    uptime: number;
    checks: {
      redis: { status: string; latency?: number };
      github: { status: string };
    };
  } = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      redis: { status: "not_configured" },
      github: { status: "ok" },
    },
  };

  // Check Redis if configured
  const redis = getRedisClient();
  if (redis) {
    try {
      const start = Date.now();
      await redis.ping();
      health.checks.redis = {
        status: "connected",
        latency: Date.now() - start,
      };
    } catch (err) {
      health.checks.redis = { status: "error" };
      health.status = "degraded";
    }
  }

  // Check GitHub App config
  if (!config.GITHUB_APP_ID || !config.GITHUB_PRIVATE_KEY || !config.GITHUB_WEBHOOK_SECRET) {
    health.checks.github = { status: "misconfigured" };
    health.status = "unhealthy";
  }

  const statusCode = health.status === "unhealthy" ? 503 : 200;
  res.status(statusCode).json(health);
});

// Root endpoint
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    message: "Vibe Scan backend is running",
    version: process.env.npm_package_version || "1.0.0",
  });
});

// Webhook endpoint
app.post("/webhook", bodyParser.raw({ type: "*/*" }), async (req: Request, res: Response) => {
  try {
    const payload = req.body instanceof Buffer ? req.body.toString("utf8") : req.body;

    await webhooks.verifyAndReceive({
      id: req.headers["x-github-delivery"] as string,
      name: req.headers["x-github-event"] as string,
      signature: req.headers["x-hub-signature-256"] as string,
      payload: payload,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Webhook] Verification failed:", err instanceof Error ? err.message : err);
    res.status(401).json({ error: "Invalid signature" });
  }
});

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log("[Server] HTTP server closed");
    });
  }

  // Close Redis connection
  try {
    await closeRedisConnection();
    console.log("[Server] Redis connection closed");
  } catch (err) {
    console.error("[Server] Error closing Redis:", err);
  }

  // Give in-flight requests time to complete (max 10 seconds)
  setTimeout(() => {
    console.log("[Server] Shutdown complete");
    process.exit(0);
  }, 10_000);
}

// Register shutdown handlers
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Unhandled rejection handler (don't crash on unhandled promises)
process.on("unhandledRejection", (reason) => {
  // Only log error message, not full stack/object to avoid leaking secrets
  const message = reason instanceof Error ? reason.message : "unknown reason";
  console.error("[Server] Unhandled Rejection:", message);
});

// Start server
server = app.listen(port, () => {
  console.log(`[Server] Vibe Scan listening on port ${port}`);
  console.log(`[Server] Health check: http://localhost:${port}/health`);
});
