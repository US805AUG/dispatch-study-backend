import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { router } from "./routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", router);

app.listen(config.port, () => {
  console.log(`Backend listening on ${config.port}`);
});
