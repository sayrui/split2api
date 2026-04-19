/**
 * sapiom2api — Deno entry point
 * Hono + drizzle-orm/postgres-js + @sapiom/fetch
 * Compatible with Deno Deploy (GitHub Actions mode with pre-built frontend)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { drizzle } from "drizzle-orm/postgres-js";
import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

// ── DB schema (inline — avoids pnpm workspace deps) ──────────────────────────

const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  provider: text("provider"),
  note: text("note"),
  isActive: boolean("is_active").notNull().default(true),
  validationStatus: text("validation_status"),
  validationMessage: text("validation_message"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── DB client ─────────────────────────────────────────────────────────────────

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (!DATABASE_URL) throw new Error("DATABASE_URL env var is required");

const queryClient = postgres(DATABASE_URL, { ssl: "require" });
const db = drizzle(queryClient, { schema: { apiKeysTable } });

// ── Sapiom SDK shims (npm: imports) ───────────────────────────────────────────

const { withSapiom } = await import("npm:@sapiom/axios");
const { default: axios } = await import("npm:axios");
const { createFetch } = await import("npm:@sapiom/fetch");

const SAPIOM_BASE = "https://openrouter.services.sapiom.ai";

type AxiosInstance = ReturnType<typeof axios.create>;
type SapiomFetch = ReturnType<typeof createFetch>;

const axiosCache = new Map<string, AxiosInstance>();
function getAxiosClient(apiKey: string): AxiosInstance {
  if (!axiosCache.has(apiKey)) {
    axiosCache.set(apiKey, withSapiom(axios.create(), { apiKey }));
  }
  return axiosCache.get(apiKey)!;
}

const fetchCache = new Map<string, SapiomFetch>();
function getFetchClient(apiKey: string): SapiomFetch {
  if (!fetchCache.has(apiKey)) {
    fetchCache.set(apiKey, createFetch({ apiKey }));
  }
  return fetchCache.get(apiKey)!;
}

async function getActiveKey(): Promise<string | null> {
  const keys = await db
    .select({ key: apiKeysTable.key })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.isActive, true));
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)].key;
}

// ── Key validation helper ─────────────────────────────────────────────────────

async function checkKeyValidity(
  key: string,
): Promise<{ status: string; message: string; httpStatus: number }> {
  const resp = await fetch("https://api.sapiom.ai/v1/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ metadata: { test: true } }),
    signal: AbortSignal.timeout(8000),
  }).catch((e: Error) => ({ status: 0, _err: e.message }));

  const apiStatus = "status" in resp ? (resp as Response).status : 0;
  let apiBody = "";
  if ("json" in resp) {
    try {
      const j = (await (resp as Response).json()) as Record<string, unknown>;
      apiBody = String(j.message || j.error || JSON.stringify(j).slice(0, 100));
    } catch { /* ignore */ }
  }

  if (apiStatus === 201 || apiStatus === 400 || apiStatus === 422) {
    return { status: "valid", message: "Key authenticated successfully", httpStatus: apiStatus };
  }
  if (apiStatus === 402) {
    return { status: "no_balance", message: "Key valid but insufficient balance", httpStatus: apiStatus };
  }
  if (apiStatus === 403 || apiStatus === 401) {
    return { status: "invalid", message: `Key rejected: ${apiBody}`, httpStatus: apiStatus };
  }
  if (apiStatus === 0) {
    return { status: "unreachable", message: "Could not reach Sapiom API", httpStatus: 0 };
  }
  return { status: "invalid", message: `Unexpected response ${apiStatus}: ${apiBody}`, httpStatus: apiStatus };
}

// ── Static file helper (serves pre-built React app from ./dist/) ──────────────

async function serveStaticFile(path: string): Promise<Response | null> {
  try {
    const filePath = `./dist${path === "/" ? "/index.html" : path}`;
    const data = await Deno.readFile(filePath);
    const ext = filePath.split(".").pop() ?? "";
    const mimeMap: Record<string, string> = {
      html: "text/html; charset=utf-8",
      js: "application/javascript",
      mjs: "application/javascript",
      css: "text/css",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      ico: "image/x-icon",
      json: "application/json",
      woff2: "font/woff2",
      woff: "font/woff",
      ttf: "font/ttf",
    };
    return new Response(data, {
      headers: { "Content-Type": mimeMap[ext] ?? "application/octet-stream" },
    });
  } catch {
    return null;
  }
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

// ── /api/keys routes ──────────────────────────────────────────────────────────

app.get("/api/keys/stats", async (c) => {
  const keys = await db.select().from(apiKeysTable);
  const active = keys.filter((k) => k.isActive).length;
  const invalid = keys.filter((k) => k.validationStatus === "invalid").length;
  const valid = keys.filter((k) => k.validationStatus === "valid").length;
  const noBalance = keys.filter((k) => k.validationStatus === "no_balance").length;
  const providerMap: Record<string, number> = {};
  for (const k of keys) {
    const p = k.provider ?? "Unknown";
    providerMap[p] = (providerMap[p] ?? 0) + 1;
  }
  const providers = Object.entries(providerMap).map(([provider, count]) => ({ provider, count }));
  return c.json({ total: keys.length, active, inactive: keys.length - active, invalid, valid, noBalance, providers });
});

app.get("/api/keys", async (c) => {
  const keys = await db.select().from(apiKeysTable).orderBy(sql`${apiKeysTable.createdAt} DESC`);
  return c.json(
    keys.map((k) => ({
      ...k,
      createdAt: k.createdAt.toISOString(),
      updatedAt: k.updatedAt.toISOString(),
      validatedAt: k.validatedAt?.toISOString() ?? null,
    })),
  );
});

const createKeySchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
  provider: z.string().optional(),
  note: z.string().optional(),
});

app.post("/api/keys", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const { name, key, provider, note } = parsed.data;
  const [created] = await db
    .insert(apiKeysTable)
    .values({ name, key, provider: provider ?? null, note: note ?? null })
    .returning();
  return c.json(
    { ...created, createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString(), validatedAt: null },
    201,
  );
});

const importKeysSchema = z.object({
  keys: z.array(z.object({ name: z.string().optional(), key: z.string().min(1), provider: z.string().optional(), note: z.string().optional() })),
});

app.post("/api/keys/import", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = importKeysSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);

  const existingKeys = await db.select({ key: apiKeysTable.key }).from(apiKeysTable);
  const existingSet = new Set(existingKeys.map((k) => k.key));
  const toInsert = parsed.data.keys.filter((k) => !existingSet.has(k.key));
  const skipped = parsed.data.keys.length - toInsert.length;

  if (toInsert.length === 0) return c.json({ imported: 0, skipped, keys: [] }, 201);

  const created = await db
    .insert(apiKeysTable)
    .values(toInsert.map((k, i) => ({ name: k.name ?? `Imported Key ${i + 1}`, key: k.key, provider: k.provider ?? null, note: k.note ?? null })))
    .returning();

  return c.json(
    { imported: created.length, skipped, keys: created.map((k) => ({ ...k, createdAt: k.createdAt.toISOString(), updatedAt: k.updatedAt.toISOString(), validatedAt: null })) },
    201,
  );
});

app.delete("/api/keys/purge-invalid", async (c) => {
  const deleted = await db.delete(apiKeysTable).where(eq(apiKeysTable.validationStatus, "invalid")).returning({ id: apiKeysTable.id });
  return c.json({ deleted: deleted.length });
});

const validateAllSchema = z.object({
  autoBan: z.boolean().default(true),
  onlyActive: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(20).default(5),
});

app.post("/api/keys/validate-all", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = validateAllSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const { autoBan, onlyActive, concurrency } = parsed.data;

  const allKeys = await db.select().from(apiKeysTable);
  const keysToCheck = onlyActive ? allKeys.filter((k) => k.isActive) : allKeys;
  let checked = 0, banned = 0, validCount = 0, invalidCount = 0, noBalanceCount = 0;

  for (let i = 0; i < keysToCheck.length; i += concurrency) {
    const chunk = keysToCheck.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (keyRow) => {
        const result = await checkKeyValidity(keyRow.key);
        checked++;
        const updates: Record<string, unknown> = { validationStatus: result.status, validationMessage: result.message, validatedAt: new Date() };
        if (autoBan && result.status === "invalid" && keyRow.isActive) { updates.isActive = false; banned++; }
        await db.update(apiKeysTable).set(updates).where(eq(apiKeysTable.id, keyRow.id));
        if (result.status === "valid") validCount++;
        else if (result.status === "invalid") invalidCount++;
        else if (result.status === "no_balance") noBalanceCount++;
      }),
    );
  }

  return c.json({ checked, banned, valid: validCount, invalid: invalidCount, noBalance: noBalanceCount, autoBan });
});

app.get("/api/keys/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const [key] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, id));
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json({ ...key, createdAt: key.createdAt.toISOString(), updatedAt: key.updatedAt.toISOString(), validatedAt: key.validatedAt?.toISOString() ?? null });
});

const updateKeySchema = z.object({
  name: z.string().optional(),
  key: z.string().optional(),
  provider: z.string().optional(),
  note: z.string().optional(),
  isActive: z.boolean().optional(),
});

app.patch("/api/keys/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = updateKeySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const [updated] = await db.update(apiKeysTable).set(parsed.data).where(eq(apiKeysTable.id, id)).returning();
  if (!updated) return c.json({ error: "Key not found" }, 404);
  return c.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString(), validatedAt: updated.validatedAt?.toISOString() ?? null });
});

app.delete("/api/keys/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const [deleted] = await db.delete(apiKeysTable).where(eq(apiKeysTable.id, id)).returning();
  if (!deleted) return c.json({ error: "Key not found" }, 404);
  return new Response(null, { status: 204 });
});

app.post("/api/keys/:id/validate", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const [keyRow] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, id));
  if (!keyRow) return c.json({ error: "Key not found" }, 404);
  const result = await checkKeyValidity(keyRow.key);
  await db.update(apiKeysTable).set({ validationStatus: result.status, validationMessage: result.message, validatedAt: new Date() }).where(eq(apiKeysTable.id, id));
  return c.json({ id, ...result });
});

// ── /v1/* proxy routes ────────────────────────────────────────────────────────

app.get("/v1/models", async (c) => {
  try {
    const apiKey = await getActiveKey();
    if (!apiKey) return c.json({ error: { message: "No active API keys available" } }, 503);
    const client = getAxiosClient(apiKey);
    const response = await client.get(`${SAPIOM_BASE}/v1/models`);
    return c.json(response.data);
  } catch {
    const fallback = [
      "openai/gpt-4o-mini", "openai/gpt-4o", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
      "anthropic/claude-sonnet-4", "anthropic/claude-haiku-3.5",
      "google/gemini-2.5-flash", "google/gemini-2.5-pro",
      "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
    ].map((id) => ({ id, object: "model" }));
    return c.json({ object: "list", data: fallback });
  }
});

app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json();
  const isStream = body.stream === true;

  const apiKey = await getActiveKey();
  if (!apiKey) return c.json({ error: { message: "No active API keys available" } }, 503);

  if (isStream) {
    const sapiomFetch = getFetchClient(apiKey);
    try {
      const upstream = await sapiomFetch(`${SAPIOM_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });

      if (!upstream.ok) {
        const errBody = await upstream.json().catch(() => ({ error: { message: `Upstream error ${upstream.status}` } }));
        return c.json(errBody, upstream.status as never);
      }

      if (!upstream.body) return c.body(null, 200);

      // Keep-alive ping every 20s + pipe upstream SSE
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const keepAlive = setInterval(() => writer.write(new TextEncoder().encode(": ping\n\n")), 20000);
      const reader = upstream.body.getReader();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally {
          clearInterval(keepAlive);
          writer.close().catch(() => {});
        }
      })();

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message: msg } }, 500);
    }
  } else {
    try {
      const client = getAxiosClient(apiKey);
      const response = await client.post(`${SAPIOM_BASE}/v1/chat/completions`, body);
      return c.json(response.data);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: unknown }; message?: string };
      return c.json(e.response?.data ?? { error: { message: e.message } }, (e.response?.status ?? 500) as never);
    }
  }
});

app.post("/v1/embeddings", async (c) => {
  const body = await c.req.json();
  try {
    const apiKey = await getActiveKey();
    if (!apiKey) return c.json({ error: { message: "No active API keys available" } }, 503);
    const client = getAxiosClient(apiKey);
    const response = await client.post(`${SAPIOM_BASE}/v1/embeddings`, body);
    return c.json(response.data);
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    return c.json(e.response?.data ?? { error: { message: e.message } }, (e.response?.status ?? 500) as never);
  }
});

// Catch-all: forward other /v1/* requests
app.all("/v1/*", async (c) => {
  const apiKey = await getActiveKey();
  if (!apiKey) return c.json({ error: { message: "No active API keys available" } }, 503);
  const client = getAxiosClient(apiKey);
  try {
    const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.json().catch(() => undefined);
    const response = await client.request({ method: c.req.method, url: `${SAPIOM_BASE}${c.req.path}`, data: body });
    return c.json(response.data);
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    return c.json(e.response?.data ?? { error: { message: e.message } }, (e.response?.status ?? 500) as never);
  }
});

// ── Frontend static files (served from ./dist/ built by GitHub Actions) ───────

app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;

  // Try exact path
  const file = await serveStaticFile(path);
  if (file) return file;

  // SPA fallback — serve index.html for unknown paths
  const index = await serveStaticFile("/index.html");
  if (index) return index;

  return c.text("Not Found", 404);
});

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = parseInt(Deno.env.get("PORT") ?? "8000");
console.log(`sapiom2api listening on port ${PORT}`);
Deno.serve({ port: PORT }, app.fetch);
