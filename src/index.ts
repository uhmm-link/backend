import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import { init as initDb } from "./db";
import { api } from "./routes";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/api", api);

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});
app.get("/review/:projectId/:stackId", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "review.html"));
});
app.get("/review/:stackId", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "review.html"));
});
// Scores: /scores/{projectId} | /scores/{projectId}/{stackId} | /scores/{projectId}/{stackId}/{sessionId}
// Legacy: /scores/{stackId}/{sessionId} — scores.html parses path and fetches accordingly
app.get(/^\/scores(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "scores.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/webhook-test", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "webhook-test.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      const storage = process.env.DATABASE_URL ? "PostgreSQL" : "JSON";
      console.log(`uhmm.link API http://localhost:${PORT} (storage: ${storage})`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
