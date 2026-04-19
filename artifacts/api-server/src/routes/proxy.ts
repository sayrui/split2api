import { Router } from "express";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import axios from "axios";
import { withSapiom } from "@sapiom/axios";

const router = Router();

const SAPIOM_BASE = "https://openrouter.services.sapiom.ai";

// Pick a random active key from the database
async function getActiveKey(): Promise<string | null> {
  const keys = await db
    .select({ key: apiKeysTable.key })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.isActive, true));

  if (keys.length === 0) return null;
  const pick = keys[Math.floor(Math.random() * keys.length)];
  return pick.key;
}

// Build a sapiom client with a given key
function buildClient(apiKey: string) {
  return withSapiom(axios.create(), { apiKey });
}

// GET /v1/models
router.get("/v1/models", async (req, res) => {
  try {
    const apiKey = await getActiveKey();
    if (!apiKey) {
      res.status(503).json({ error: { message: "No active API keys available" } });
      return;
    }
    const client = buildClient(apiKey);
    const response = await client.get(`${SAPIOM_BASE}/v1/models`);
    res.json(response.data);
  } catch (err: any) {
    const fallbackModels = [
      "openai/gpt-4o-mini", "openai/gpt-4o", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
      "anthropic/claude-sonnet-4", "anthropic/claude-haiku-3.5",
      "google/gemini-2.5-flash", "google/gemini-2.5-pro",
      "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
    ].map((id) => ({ id, object: "model" }));
    res.json({ object: "list", data: fallbackModels });
  }
});

// POST /v1/chat/completions
router.post("/v1/chat/completions", async (req, res) => {
  const body = req.body;
  const isStream = body.stream === true;

  req.log.info({ model: body.model, stream: isStream }, "chat/completions");

  try {
    const apiKey = await getActiveKey();
    if (!apiKey) {
      res.status(503).json({ error: { message: "No active API keys available" } });
      return;
    }
    const client = buildClient(apiKey);

    if (isStream) {
      const response = await client.post(`${SAPIOM_BASE}/v1/chat/completions`, body, {
        responseType: "stream",
        decompress: false,
        headers: {
          Accept: "text/event-stream",
          "Accept-Encoding": "identity",
        },
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Keep-alive ping every 20s to prevent Replit 300s proxy timeout
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": ping\n\n");
        }
      }, 20000);

      response.data.on("data", (chunk: Buffer) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });

      response.data.on("end", () => {
        clearInterval(keepAlive);
        if (!res.writableEnded) res.end();
      });

      response.data.on("error", (err: Error) => {
        clearInterval(keepAlive);
        req.log.error({ err }, "Stream error");
        if (!res.writableEnded) res.end();
      });

      req.on("close", () => {
        clearInterval(keepAlive);
        response.data.destroy();
      });
    } else {
      const response = await client.post(`${SAPIOM_BASE}/v1/chat/completions`, body);
      res.json(response.data);
    }
  } catch (err: any) {
    req.log.error({ status: err.response?.status, data: err.response?.data }, "proxy error");
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: { message: err.message } };
    res.status(status).json(data);
  }
});

// POST /v1/embeddings
router.post("/v1/embeddings", async (req, res) => {
  const body = req.body;
  req.log.info({ model: body.model }, "embeddings");

  try {
    const apiKey = await getActiveKey();
    if (!apiKey) {
      res.status(503).json({ error: { message: "No active API keys available" } });
      return;
    }
    const client = buildClient(apiKey);
    const response = await client.post(`${SAPIOM_BASE}/v1/embeddings`, body);
    res.json(response.data);
  } catch (err: any) {
    req.log.error({ status: err.response?.status }, "embeddings error");
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: { message: err.message } };
    res.status(status).json(data);
  }
});

export default router;
