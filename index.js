// index.js
// One-file backend (ESM) — Express + CORS + dotenv + OpenAI

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import path from "path";
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

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const safe = Date.now() + "-" + file.originalname.replace(/[^\w.\-]/g, "_");
      cb(null, safe);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const NUTRITION_SYSTEM_PROMPT = `
You are an advanced food nutrition estimation AI.

Your job is to carefully analyze a meal description and return structured nutrition data.

CORE TASKS:
Identify all food items separately.
Estimate portion size in grams for each item.
Estimate calories per item realistically.
Estimate protein, carbs, and fats per item.
Calculate total macros using:
Protein: 4 calories per gram
Carbs: 4 calories per gram
Fats: 9 calories per gram
Ensure totals are internally consistent.
Estimate a realistic Nutri-Score (A/B/C/D/E) for the overall meal.
Be conservative if uncertain. Do NOT invent ingredients.

TITLE RULE:
Create a short, natural-sounding title (a few words only) that clearly describes the meal.
Use proper capitalization.

RESPONSE FORMAT - Return STRICT JSON only, no extra text:

{
  "title": "",
  "nutri_score": "",
  "items": [
    {
      "name": "",
      "estimated_grams": 0,
      "calories": 0,
      "protein": 0,
      "carbs": 0,
      "fats": 0
    }
  ],
  "macros": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fats": 0
  }
}

STRICT RULES:
Only return valid JSON. No explanations. No extra text.
All numbers must be integers. No units next to numbers.
Nutri-Score must be one of: A, B, C, D, E.
`.trim();

// ---------------- ANALYZE TEXT ROUTE ----------------
app.post("/analyze_text", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: NUTRITION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Here is the user's meal description:\n\n${text.trim()}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const jsonText = response.choices[0].message.content?.trim();

    if (!jsonText)
      return res.status(502).json({ error: "Model returned empty output" });

    const parsed = JSON.parse(jsonText);
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------- ANALYZE AUDIO ROUTE ----------------
app.post("/analyze_audio", upload.single("file"), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!filePath)
      return res.status(400).json({ error: "Missing audio file. Use field name: file" });

    const transcription = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(filePath),
      response_format: "json",
    });

    const transcriptText = transcription?.text?.trim();

    if (!transcriptText)
      return res.status(502).json({ error: "Empty transcription result" });

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: NUTRITION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Here is the user's meal description:\n\n${transcriptText}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const jsonText = response.choices[0].message.content?.trim();

    if (!jsonText)
      return res.status(502).json({ error: "Model returned empty output" });

    const parsed = JSON.parse(jsonText);
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});


app.post("/analyze", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    const systemPrompt = `
You are an advanced food vision and nutrition estimation AI.
Your job is to carefully analyze a meal image and return structured nutrition data.

CORE TASKS

Identify all clearly visible food items separately.
Estimate portion size in grams for each item.
Estimate calories per item realistically.
Estimate protein, carbs, and fats per item internally.
Calculate total macros using:
Protein: 4 calories per gram
Carbs: 4 calories per gram
Fats: 9 calories per gram
Ensure totals are internally consistent.
Estimate a realistic Nutri-Score (A/B/C/D/E) for the overall meal based on nutritional quality (fiber, protein quality, processing level, saturated fat, sugar, overall balance). Be honest and conservative — do not artificially improve the score.
Be conservative if uncertain. Do NOT invent invisible ingredients.

TITLE RULE

Create a short, natural-sounding title (a few words only) that clearly describes the visible main ingredients and the type of dish.
Rules:

The title must reflect the actual visible ingredients.
Do not invent ingredients.
Do not use generic titles like "Healthy Meal".
Keep it concise and descriptive.
Use proper capitalization.

RESPONSE FORMAT

Return STRICT JSON in this format:

{
  "title": "",
  "nutri_score": "",
  "items": [
    {
      "name": "",
      "estimated_grams": 0,
      "calories": 0,
      "protein": 0,
      "carbs": 0,
      "fats": 0
    }
  ],
  "macros": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fats": 0
  }
}

STRICT RULES:
Only return valid JSON.
No explanations.
No extra text.
All numbers must be integers.
No units next to numbers.
Macros are in grams except calories.
Nutri-Score must be one of: A, B, C, D, E.
Total calories must approximately equal:
(protein*4 + carbs*4 + fats*9)
If image is not food, return:

{
  "title": "Not a Food Item",
  "nutri_score": "E",
  "items": [],
  "macros": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fats": 0
  }
}`;

    const requestBody = {
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this meal." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
    };

    let response;

    try {
      response = await client.chat.completions.create(requestBody);
    } catch (err) {
      console.log("Mini failed, switching to nano...");

      response = await client.chat.completions.create({
        ...requestBody,
        model: "gpt-4.1-nano",
      });
    }

    const content = response.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(500).json({ error: "Invalid JSON returned from model" });
    }

    res.json(parsed);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});


// ---------------- BARCODE ROUTE ----------------
app.post("/barcode", async (req, res) => {
  try {
    const { barcode } = req.body;
    if (!barcode) return res.status(400).json({ error: "barcode is required" });

    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;

    const r = await fetch(url, {
      headers: { "User-Agent": "EatLessLab/1.0 (contact: you@example.com)" },
    });

    if (!r.ok) return res.status(502).json({ error: "OpenFoodFacts error" });

    const data = await r.json();
    if (data?.status !== 1 || !data?.product)
      return res.status(404).json({ error: "Product not found" });

    const p = data.product;
    const n = p.nutriments || {};

    // ---------- helpers ----------
    const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    const round = (v, decimals = 4) => {
      if (v == null || !Number.isFinite(v)) return null;
      const f = Math.pow(10, decimals);
      return Math.round(v * f) / f;
    };

    const normalizeUnit = (u) =>
      typeof u === "string" ? u.trim().toLowerCase().replace(/\./g, "") : null;

    const isLiquidUnit = (u) => {
      const x = normalizeUnit(u);
      return x === "ml" || x === "l" || x === "cl" || x === "dl" || x === "floz" || x === "fl oz";
    };

    // 1ml = 1g assumption is baked into this conversion table
    const unitToMlOrGMultiplier = (unit) => {
      const u = normalizeUnit(unit);
      if (!u) return null;

      // mass
      if (u === "g") return 1;
      if (u === "kg") return 1000;
      if (u === "mg") return 0.001;
      if (u === "oz") return 28.349523125;

      // volume
      if (u === "ml") return 1;
      if (u === "l") return 1000;
      if (u === "cl") return 10;
      if (u === "dl") return 100;
      if (u === "floz" || u === "fl oz") return 29.5735295625;

      return null;
    };

    const parseQuantityString = (quantityStr) => {
      if (!quantityStr || typeof quantityStr !== "string") return null;
      let s = quantityStr.toLowerCase().replace(",", ".").trim();
      s = s.replace(/\s+/g, " ");

      const m = s.match(/(\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\b/);
      if (!m) return null;

      const amount = Number(m[1]);
      const unit = m[3];
      const mul = unitToMlOrGMultiplier(unit);
      if (!mul) return null;

      return amount * mul; // returns "base amount" in ml-or-g numeric space
    };

    const pickName = () =>
      p.product_name_en ||
      p.product_name ||
      p.generic_name_en ||
      p.generic_name ||
      "Unknown";

    const pickNutriScore = () => {
      const g =
        (typeof p.nutriscore_grade === "string" && p.nutriscore_grade) ||
        (typeof p.nutrition_grade_fr === "string" && p.nutrition_grade_fr) ||
        null;
      return g ? g.toUpperCase() : null;
    };

    // ---------- product image ----------
    const imageUrl =
      p.image_front_url ||
      p.image_front_small_url ||
      p.image_url ||
      p.image_small_url ||
      null;

    // ---------- detect type ----------
    const isDrink = isLiquidUnit(p.product_quantity_unit);
    const type = isDrink ? "drink" : "food";

    // ---------- pack amount (ml for drinks, g for food; numeric is same space due to 1ml=1g assumption) ----------
    const packFromProductQuantity = (() => {
      const qty = toNumber(p.product_quantity);
      if (qty == null) return null;
      const mul = unitToMlOrGMultiplier(p.product_quantity_unit);
      if (!mul) return null;
      return qty * mul;
    })();

    const packFromQuantityString = parseQuantityString(p.quantity);
    const packAmountBase = packFromProductQuantity ?? packFromQuantityString ?? null;

    const packBaseUnit = isDrink ? "ml" : "g";

    // ---------- nutriments per100 ----------
    // Drinks: prefer _100ml, fallback to _100g
    // Food: use _100g (fallback to _100ml if exists for weird cases)
    const getPer100 = () => {
      const pick = (key) => {
        if (isDrink) {
          return toNumber(n[`${key}_100ml`]) ?? toNumber(n[`${key}_100g`]) ?? null;
        }
        return toNumber(n[`${key}_100g`]) ?? toNumber(n[`${key}_100ml`]) ?? null;
      };

      const kcal =
        (isDrink
          ? toNumber(n["energy-kcal_100ml"]) ?? toNumber(n["energy-kcal_100g"])
          : toNumber(n["energy-kcal_100g"]) ?? toNumber(n["energy-kcal_100ml"])) ??
        null;

      if (kcal != null) {
        return {
          calories: kcal,
          protein: pick("proteins"),
          carbs: pick("carbohydrates"),
          fat: pick("fat"),
          salt: pick("salt"),
        };
      }

      // kcal missing -> try kJ
      const kj =
        (isDrink
          ? toNumber(n["energy-kj_100ml"]) ??
            toNumber(n["energy-kj_100g"]) ??
            toNumber(n["energy_100ml"]) ??
            toNumber(n["energy_100g"])
          : toNumber(n["energy-kj_100g"]) ??
            toNumber(n["energy_100g"]) ??
            toNumber(n["energy-kj_100ml"]) ??
            toNumber(n["energy_100ml"])) ?? null;

      return {
        calories: kj != null ? kj / 4.184 : null,
        protein: pick("proteins"),
        carbs: pick("carbohydrates"),
        fat: pick("fat"),
        salt: pick("salt"),
      };
    };

    const per100 = getPer100();

    const scale = (factor, decimals = 4) => ({
      calories: per100.calories == null ? null : round(per100.calories * factor, decimals),
      protein: per100.protein == null ? null : round(per100.protein * factor, decimals),
      carbs: per100.carbs == null ? null : round(per100.carbs * factor, decimals),
      fat: per100.fat == null ? null : round(per100.fat * factor, decimals),
      salt: per100.salt == null ? null : round(per100.salt * factor, decimals),
    });

    // ---------- outputs (same fields) ----------
    const per1g = !isDrink ? { unit: "g", amount: 1, ...scale(1 / 100, 6) } : null;

    const perOz = !isDrink
      ? { unit: "oz", amount: 1, ...scale(28.349523125 / 100, 4) }
      : null;

    const perCup250ml = isDrink ? { unit: "ml", amount: 250, ...scale(250 / 100, 3) } : null;

    const perPackage =
      packAmountBase != null
        ? {
            unit: packBaseUnit,
            amount: round(packAmountBase, 0),
            ...scale(packAmountBase / 100, 3),
          }
        : null;

    return res.json({
      type,
      brand: p.brands,
      isDrink,
      name: pickName(),
      imageUrl,
      nutriScore: pickNutriScore(),
      pack: {
        amountBase: packAmountBase != null ? round(packAmountBase, 0) : null,
        baseUnit: packBaseUnit,
      },
      per1g,
      perOz,
      perCup250ml,
      perPackage,
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