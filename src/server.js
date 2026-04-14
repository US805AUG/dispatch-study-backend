import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { router } from "./routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/api", router);

// Log any request that didn't match a route so we can see what the iOS app is calling
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

// Global error handler — catches anything that escapes route-level try/catch
// and prevents unhandled rejections from crashing Node.js
app.use((err, req, res, next) => {
  console.error(`[unhandled error] ${req.method} ${req.path}`, err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(config.port, () => {
  console.log(`Backend listening on ${config.port}`);
});
