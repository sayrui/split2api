import { Router } from "express";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import axios, { type AxiosInstance } from "axios";
import { withSapiom } from "@sapiom/axios";

const router = Router();

const SAPIOM_BASE = "https://openrouter.services.sapiom.ai";

// Cache one client per API key — mirrors how the original server.js works
// (one persistent sapiomClient at startup rather than recreating per request)
const clientCache = new Map<string, AxiosInstance>();

function getClient(apiKey: string): AxiosInstance {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, withSapiom(axios.create(), { apiKey }));
  }
  return clientCache.get(apiKey)!;
}

async function getActiveKey(): Promise<string | null> {
  const keys = await db
    .select({ key: apiKeysTable.key })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.isActive, true));
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)].key;
}

// GET /v1/models
router.get("/v1/models", async (req, res) => {
  try {
    const apiKey = await getActiveKey();
    if (!apiKey) {
      res.status(503).json({ error: { message: "No active API keys available" } });
      return;
    }
    const client = getClient(apiKey);
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

  const apiKey = await getActiveKey();
  if (!apiKey) {
    res.status(503).json({ error: { message: "No active API keys available" } });
    return;
  }

  const client = getClient(apiKey);

  if (isStream) {
    // Step 1: make a non-stream preflight so @sapiom/axios can handle x402 auth properly.
    // The interceptor cannot parse 402 body when responseType is 'stream',
    // so we get authorization first with a regular request, then stream.
    let paymentHeaders: Record<string, string> = {};
    try {
      // Use axios without stream to trigger the sapiom auth flow
      // Send stream:false so the server doesn't start streaming on this call
      await client.post(
        `${SAPIOM_BASE}/v1/chat/completions`,
        { ...body, stream: false, max_tokens: 1 },
        { timeout: 15000 }
      );
      // Auth headers are now embedded in the cached client for subsequent calls
    } catch (prefErr: any) {
      // Extract any payment/auth headers the interceptor may have added to config
      const headers = prefErr?.config?.headers ?? {};
      for (const h of ["PAYMENT-SIGNATURE", "X-PAYMENT", "X-Sapiom-Transaction-Id"]) {
        if (headers[h]) paymentHeaders[h] = headers[h];
      }
      if (prefErr.response?.status !== 402 && prefErr.response?.status !== 200 && !Object.keys(paymentHeaders).length) {
        req.log.warn({ status: prefErr.response?.status }, "preflight failed but continuing with stream");
      }
    }

    // Step 2: now do the real streaming request.
    // Collect any auth headers from recent successful calls on this client instance.
    try {
      const response = await client.post(
        `${SAPIOM_BASE}/v1/chat/completions`,
        body,
        {
          responseType: "stream",
          decompress: false,
          timeout: 310000, // slightly over 300s — keep-alive handles the rest
          headers: {
            Accept: "text/event-stream",
            "Accept-Encoding": "identity",
            ...paymentHeaders,
          },
        }
      );

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Send keep-alive ping every 20s to beat Replit's 300s proxy timeout
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 20000);

      response.data.on("data", (chunk: Buffer) => {
        if (!res.writableEnded) res.write(chunk);
      });

      response.data.on("end", () => {
        clearInterval(keepAlive);
        if (!res.writableEnded) res.end();
      });

      response.data.on("error", (err: Error) => {
        clearInterval(keepAlive);
        req.log.error({ err }, "stream error");
        if (!res.writableEnded) res.end();
      });

      req.on("close", () => {
        clearInterval(keepAlive);
        response.data.destroy();
      });
    } catch (err: any) {
      req.log.error({ status: err.response?.status }, "stream request failed");
      const status = err.response?.status || 500;
      const data = err.response?.data || { error: { message: err.message } };
      if (!res.headersSent) {
        res.status(status).json(data);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  } else {
    // Non-streaming
    try {
      const response = await client.post(`${SAPIOM_BASE}/v1/chat/completions`, body);
      res.json(response.data);
    } catch (err: any) {
      const status = err.response?.status || 500;
      const data = err.response?.data || { error: { message: err.message } };
      res.status(status).json(data);
    }
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
    const client = getClient(apiKey);
    const response = await client.post(`${SAPIOM_BASE}/v1/embeddings`, body);
    res.json(response.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: { message: err.message } };
    res.status(status).json(data);
  }
});

export default router;
