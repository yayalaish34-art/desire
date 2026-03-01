// index.js
// One-file backend (ESM) — Express + CORS + dotenv + OpenAI

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// ---------------- BARCODE ROUTE ----------------
app.post("/barcode", async (req, res) => {
  try {
    const { barcode } = req.body;
    if (!barcode)
      return res.status(400).json({ error: "barcode is required" });

    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;

    const r = await fetch(url, {
      headers: {
        "User-Agent": "EatLessLab/1.0 (contact: you@example.com)",
      },
    });

    if (!r.ok)
      return res.status(502).json({ error: "OpenFoodFacts error" });

    const data = await r.json();
    if (data?.status !== 1 || !data?.product)
      return res.status(404).json({ error: "Product not found" });

    const p = data.product;
    const n = p.nutriments || {};

    // ---------- IMAGE ----------
    const imageUrl =
      p.image_front_url ||
      p.image_front_small_url ||
      p.image_url ||
      p.image_small_url ||
      null;

    // ---------- HELPERS ----------
    const toNumber = (v) =>
      Number.isFinite(Number(v)) ? Number(v) : null;

    const parseGrams = (str) => {
      if (!str || typeof str !== "string") return null;
      const s = str.toLowerCase().replace(",", ".");
      const m = s.match(/(\d+(\.\d+)?)\s*(g|kg)\b/);
      if (!m) return null;
      const num = Number(m[1]);
      return m[3] === "kg" ? num * 1000 : num;
    };

    const round = (v) =>
      v == null ? null : Math.round(v * 10) / 10;

    // ---------- BASE VALUES (100g) ----------
    const per100g = {
      calories:
        toNumber(n["energy-kcal_100g"]) ??
        (toNumber(n["energy_100g"]) != null
          ? toNumber(n["energy_100g"]) / 4.184
          : null),
      protein: toNumber(n["proteins_100g"]),
      carbs: toNumber(n["carbohydrates_100g"]),
      fat: toNumber(n["fat_100g"]),
      sugar: toNumber(n["sugars_100g"]),
    };

    // ---------- SERVING ----------
    const servingGrams =
      parseGrams(p.serving_size) ??
      toNumber(p.serving_quantity);

    const perServing = servingGrams
      ? {
          calories: round((per100g.calories * servingGrams) / 100),
          protein: round((per100g.protein * servingGrams) / 100),
          carbs: round((per100g.carbs * servingGrams) / 100),
          fat: round((per100g.fat * servingGrams) / 100),
          sugar: round((per100g.sugar * servingGrams) / 100),
        }
      : null;

    // ---------- TOTAL PACKAGE ----------
    const totalGrams =
      parseGrams(p.product_quantity) ??
      toNumber(p.product_quantity);

    const perPackage = totalGrams
      ? {
          calories: round((per100g.calories * totalGrams) / 100),
          protein: round((per100g.protein * totalGrams) / 100),
          carbs: round((per100g.carbs * totalGrams) / 100),
          fat: round((per100g.fat * totalGrams) / 100),
          sugar: round((per100g.sugar * totalGrams) / 100),
        }
      : null;

    // ---------- 100 OZ (2,834.95g) ----------
    const OZ100_IN_GRAMS = 2834.95;

    const per100oz = {
      calories: round((per100g.calories * OZ100_IN_GRAMS) / 100),
      protein: round((per100g.protein * OZ100_IN_GRAMS) / 100),
      carbs: round((per100g.carbs * OZ100_IN_GRAMS) / 100),
      fat: round((per100g.fat * OZ100_IN_GRAMS) / 100),
      sugar: round((per100g.sugar * OZ100_IN_GRAMS) / 100),
    };

    return res.json({
      name: p.product_name_en || p.product_name || "Unknown",
      imageUrl,

      per100g: {
        calories: round(per100g.calories),
        protein: round(per100g.protein),
        carbs: round(per100g.carbs),
        fat: round(per100g.fat),
        sugar: round(per100g.sugar),
      },

      perServing: servingGrams
        ? {
            grams: servingGrams,
            ...perServing,
          }
        : null,

      per100oz,

      perPackage: totalGrams
        ? {
            grams: totalGrams,
            ...perPackage,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------- CALORIES BURNED ROUTE ----------------
app.post("/api/calories/burned", async (req, res) => {
  try {
    let { description, weightKg, age, sex } = req.body || {};

    const input = [
      {
        role: "system",
        content:
          "You estimate calories burned from workouts. Be realistic and conservative.",
      },
      {
        role: "user",
        content: `
description: ${description}
weightKg: ${weightKg}
age: ${age}
sex: ${sex}

Return JSON:
{
  "calories": number
}
`,
      },
    ];

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "calories_burned",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["calories"],
            properties: {
              calories: { type: "number" },
            },
          },
        },
      },
      max_output_tokens: 100,
    });

    const text = (response.output_text || "").trim();
    const parsed = JSON.parse(text);

    return res.json({
      calories: parsed.calories,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);