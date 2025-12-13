import express, { Request, Response, NextFunction } from "express";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import { config } from "./env";
import { webhooks, registerEventHandlers, analyzeForApi } from "./integrations/github";
import { getRedisClient, closeRedisConnection } from "./redis";
import { logger } from "./logger";

// Fail fast if Redis is not configured (required for token quota protection)
if (!config.REDIS_URL) {
  console.error("FATAL: REDIS_URL is required for token quota protection. Exiting.");
  process.exit(1);
}

const app = express();
const port = Number(config.PORT) || 3000;

// Trust proxy - required for Railway/cloud deployments behind load balancers
// This enables correct client IP detection for rate limiting
app.set("trust proxy", 1);

// Track server state for graceful shutdown
// vibecheck-ignore-next-line GLOBAL_MUTATION
let isShuttingDown = false;
// vibecheck-ignore-next-line GLOBAL_MUTATION
let server: ReturnType<typeof app.listen> | null = null;

// Request timeout (30 seconds for most, 120 for webhook processing)
const DEFAULT_TIMEOUT_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 120_000;

// Rate limiting - prevent abuse
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health", // Don't rate limit health checks
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 webhooks per minute (1/sec avg, allows bursts)
  message: { error: "Too many webhook requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use(generalLimiter);
app.use("/webhook", webhookLimiter);

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
    message: "Vibe Check backend is running",
    version: process.env.npm_package_version || "1.0.0",
  });
});

// Webhook endpoint - responds immediately, processes async
app.post("/webhook", bodyParser.raw({ type: "*/*" }), async (req: Request, res: Response) => {
  const payload = req.body instanceof Buffer ? req.body.toString("utf8") : req.body;
  const signature = req.headers["x-hub-signature-256"] as string;
  const id = req.headers["x-github-delivery"] as string;
  const name = req.headers["x-github-event"] as string;

  // Verify signature synchronously before responding
  try {
    await webhooks.verify(payload, signature);
  } catch (err) {
    logger.error("Webhook signature verification failed", {
      deliveryId: id,
      event: name,
      error: err instanceof Error ? err.message : "unknown",
    });
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Respond immediately - GitHub expects response within 10 seconds
  res.status(200).json({ ok: true });

  // Process webhook in background (fire and forget)
  logger.info("Processing webhook", { deliveryId: id, event: name });

  // Parse payload - webhooks.receive expects an object, not a string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsedPayload: any;
  try {
    parsedPayload = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch (err) {
    logger.error("Failed to parse webhook payload", { deliveryId: id, event: name });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webhooks.receive({ id, name: name as any, payload: parsedPayload }).catch((err) => {
    logger.error("Webhook handler error", {
      deliveryId: id,
      event: name,
      error: err instanceof Error ? err.message : "unknown",
    });
  });
});

// API endpoint for GitHub Actions integration
// This allows the lightweight action to call the hosted service
app.post("/api/analyze", async (req: Request, res: Response) => {
  const { owner, repo, pull_number } = req.body;

  // Validate required fields
  if (!owner || !repo || !pull_number) {
    res.status(400).json({
      success: false,
      error: "Missing required fields: owner, repo, pull_number",
    });
    return;
  }

  // Validate types
  if (typeof owner !== "string" || typeof repo !== "string") {
    res.status(400).json({
      success: false,
      error: "owner and repo must be strings",
    });
    return;
  }

  const prNumber = Number(pull_number);
  if (isNaN(prNumber) || prNumber <= 0) {
    res.status(400).json({
      success: false,
      error: "pull_number must be a positive integer",
    });
    return;
  }

  try {
    logger.info("API analysis requested", { owner, repo, pullNumber: prNumber });
    const result = await analyzeForApi(owner, repo, prNumber);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error("API analysis failed", {
      owner,
      repo,
      pullNumber: prNumber,
      error: error instanceof Error ? error.message : "unknown",
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  logger.info("Graceful shutdown started", { signal });
  isShuttingDown = true;

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info("HTTP server closed");
    });
  }

  // Close Redis connection
  try {
    await closeRedisConnection();
    logger.info("Redis connection closed");
  } catch (err) {
    logger.error("Error closing Redis", { error: err instanceof Error ? err.message : "unknown" });
  }

  // Give in-flight requests time to complete (max 10 seconds)
  setTimeout(() => {
    logger.info("Shutdown complete");
    process.exit(0);
  }, 10_000);
}

// Register shutdown handlers
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Unhandled rejection handler (don't crash on unhandled promises)
// vibecheck-ignore-next-line SILENT_ERROR
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    error: reason instanceof Error ? reason.message : "unknown",
  });
});

// Start server - bind to 0.0.0.0 for Railway/Docker
console.log(`[Server] Starting on 0.0.0.0:${port} (PORT env: ${process.env.PORT})`);
server = app.listen(port, "0.0.0.0", () => {
  console.log(`[Server] Listening on 0.0.0.0:${port}`);
});
