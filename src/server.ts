import express from "express";
import bodyParser from "body-parser";
import { config } from "./config";
import { webhooks, registerEventHandlers } from "./github";

const app = express();
const port = Number(config.PORT) || 3000;

// JSON parsing for all routes except /webhook
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});

// Register GitHub event handlers
registerEventHandlers();

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Vibe Scan backend is running",
  });
});

app.post("/webhook", bodyParser.raw({ type: "*/*" }), async (req, res) => {
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
    console.error("Webhook verification failed:", err);
    res.status(401).json({ error: "Invalid signature" });
  }
});

app.listen(port, () => {
  console.log(`Vibe Scan server listening on port ${port}`);
});
