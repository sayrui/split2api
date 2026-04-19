import { Router } from "express";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

const router = Router();

router.get("/keys/stats", async (req, res) => {
  try {
    const keys = await db.select().from(apiKeysTable);
    const active = keys.filter((k) => k.isActive).length;
    const inactive = keys.length - active;

    const providerMap: Record<string, number> = {};
    for (const k of keys) {
      const p = k.provider ?? "Unknown";
      providerMap[p] = (providerMap[p] ?? 0) + 1;
    }
    const providers = Object.entries(providerMap).map(([provider, count]) => ({ provider, count }));

    res.json({ total: keys.length, active, inactive, providers });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/keys", async (req, res) => {
  try {
    const keys = await db.select().from(apiKeysTable).orderBy(sql`${apiKeysTable.createdAt} DESC`);
    res.json(
      keys.map((k) => ({
        ...k,
        createdAt: k.createdAt.toISOString(),
        updatedAt: k.updatedAt.toISOString(),
      }))
    );
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

const createKeySchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
  provider: z.string().optional(),
  note: z.string().optional(),
});

router.post("/keys", async (req, res) => {
  try {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { name, key, provider, note } = parsed.data;
    const [created] = await db
      .insert(apiKeysTable)
      .values({ name, key, provider: provider ?? null, note: note ?? null })
      .returning();
    res.status(201).json({
      ...created,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

const importKeysSchema = z.object({
  keys: z.array(
    z.object({
      name: z.string().optional(),
      key: z.string().min(1),
      provider: z.string().optional(),
      note: z.string().optional(),
    })
  ),
});

router.post("/keys/import", async (req, res) => {
  try {
    const parsed = importKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const existingKeys = await db.select({ key: apiKeysTable.key }).from(apiKeysTable);
    const existingSet = new Set(existingKeys.map((k) => k.key));

    const toInsert = parsed.data.keys.filter((k) => !existingSet.has(k.key));
    const skipped = parsed.data.keys.length - toInsert.length;

    if (toInsert.length === 0) {
      res.status(201).json({ imported: 0, skipped, keys: [] });
      return;
    }

    const created = await db
      .insert(apiKeysTable)
      .values(
        toInsert.map((k, i) => ({
          name: k.name ?? `Imported Key ${i + 1}`,
          key: k.key,
          provider: k.provider ?? null,
          note: k.note ?? null,
        }))
      )
      .returning();

    res.status(201).json({
      imported: created.length,
      skipped,
      keys: created.map((k) => ({
        ...k,
        createdAt: k.createdAt.toISOString(),
        updatedAt: k.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/keys/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [key] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, id));
    if (!key) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ...key, createdAt: key.createdAt.toISOString(), updatedAt: key.updatedAt.toISOString() });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

const updateKeySchema = z.object({
  name: z.string().optional(),
  key: z.string().optional(),
  provider: z.string().optional(),
  note: z.string().optional(),
  isActive: z.boolean().optional(),
});

router.patch("/keys/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = updateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const [updated] = await db
      .update(apiKeysTable)
      .set(parsed.data)
      .where(eq(apiKeysTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/keys/:id/validate", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [keyRow] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, id));
    if (!keyRow) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    // Test 1: api.sapiom.ai authentication (used by SDK for transaction creation)
    const authResp = await fetch("https://api.sapiom.ai/v1/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": keyRow.key,
      },
      body: JSON.stringify({ metadata: { test: true } }),
      signal: AbortSignal.timeout(8000),
    }).catch((e) => ({ status: 0, _err: e.message }));

    const apiStatus = "status" in authResp ? (authResp as Response).status : 0;
    let apiBody = "";
    if ("json" in authResp) {
      try {
        const j = await (authResp as Response).json();
        apiBody = j.message || j.error || JSON.stringify(j).slice(0, 100);
      } catch {}
    }

    // 201 = transaction created (valid key with balance)
    // 422/400 = valid key but bad payload
    // 403 = invalid key
    // 402 = valid key but no balance
    const valid = apiStatus === 201 || apiStatus === 400 || apiStatus === 422;
    const noBalance = apiStatus === 402;
    const invalidKey = apiStatus === 403 || apiStatus === 401;

    let status: "valid" | "no_balance" | "invalid" | "unreachable";
    let message: string;

    if (valid) {
      status = "valid";
      message = "Key authenticated successfully with Sapiom API";
    } else if (noBalance) {
      status = "no_balance";
      message = "Key is valid but account has insufficient balance";
    } else if (invalidKey) {
      status = "invalid";
      message = `Key rejected by Sapiom API: ${apiBody}`;
    } else if (apiStatus === 0) {
      status = "unreachable";
      message = "Could not reach Sapiom API";
    } else {
      status = "invalid";
      message = `Unexpected response ${apiStatus}: ${apiBody}`;
    }

    res.json({ id, status, message, httpStatus: apiStatus });
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/keys/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [deleted] = await db.delete(apiKeysTable).where(eq(apiKeysTable.id, id)).returning();
    if (!deleted) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.status(204).send();
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
