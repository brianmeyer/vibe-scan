import express from "express";
import bodyParser from "body-parser";
import { config } from "./config";

const app = express();
const port = Number(config.PORT) || 3000;

app.use(bodyParser.json());

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Vibe Scan backend is running",
  });
});

app.post("/webhook", (req, res) => {
  const event = req.headers["x-github-event"];
  console.log(`Received webhook: ${event || "unknown event"}`);
  console.log("Delivery ID:", req.headers["x-github-delivery"]);

  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`Vibe Scan server listening on port ${port}`);
});
