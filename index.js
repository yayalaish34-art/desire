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

    // ---------- IMAGE ----------
    const imageUrl =
      p.image_front_url ||
      p.image_front_small_url ||
      p.image_url ||
      p.image_small_url ||
      null;

    // ---------- HELPERS ----------
    const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    const round = (v, decimals = 4) => {
      if (v == null || !Number.isFinite(v)) return null;
      const f = Math.pow(10, decimals);
      return Math.round(v * f) / f;
    };

    const normalizeUnit = (u) =>
      typeof u === "string" ? u.trim().toLowerCase().replace(/\./g, "") : null;

    // base: food -> grams, drink -> ml
    const unitToBaseMultiplier = (unit, baseType) => {
      const u = normalizeUnit(unit);
      if (!u) return null;

      if (baseType === "g") {
        if (u === "g") return 1;
        if (u === "kg") return 1000;
        if (u === "mg") return 0.001;
        if (u === "oz") return 28.349523125;
        return null;
      }

      if (baseType === "ml") {
        if (u === "ml") return 1;
        if (u === "l") return 1000;
        if (u === "cl") return 10;
        if (u === "dl") return 100;
        if (u === "floz" || u === "fl oz") return 29.5735295625;
        return null;
      }

      return null;
    };

    // Parse "quantity" string: "6 x 50 g", "1.5 L", "12 fl oz", "500ml"
    const parseQuantityStringToBase = (quantityStr, baseType) => {
      if (!quantityStr || typeof quantityStr !== "string") return null;

      let s = quantityStr.toLowerCase().replace(",", ".").trim();
      s = s.replace(/\s+/g, " ");

      // handle "6 x 50 g" / "6x50g"
      const multi = s.match(
        /(\d+)\s*x\s*(\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\b/
      );
      if (multi) {
        const count = Number(multi[1]);
        const amount = Number(multi[2]);
        const unit = multi[4];
        const mul = unitToBaseMultiplier(unit, baseType);
        if (!mul) return null;
        return count * amount * mul;
      }

      // single "500 g" / "1.5 l" / "12 fl oz" / "500ml"
      const single = s.match(
        /(\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\b/
      );
      if (!single) return null;

      const amount = Number(single[1]);
      const unit = single[3];
      const mul = unitToBaseMultiplier(unit, baseType);
      if (!mul) return null;
      return amount * mul;
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
      return g ? g.toUpperCase() : null; // A/B/C/D/E
    };

    // ---------- DETECT TYPE (ONLY product_quantity_unit) ----------
    const isLiquidUnit = (u) => {
      const x = normalizeUnit(u);
      return (
        x === "ml" ||
        x === "L" ||
        x === "l" ||
        x === "cl" ||
        x === "dl" ||
        x === "floz" ||
        x === "fl oz"
      );
    };

    const isDrink = isLiquidUnit(p.product_quantity_unit);
    const type = isDrink ? "drink" : "food";
    const baseType = isDrink ? "ml" : "g"; // package base

    // ---------- PACK AMOUNT (base) ----------
    const packFromProductQuantity = (() => {
      const qty = toNumber(p.product_quantity);
      const unit = p.product_quantity_unit;
      if (qty == null) return null;

      const mul = unitToBaseMultiplier(unit, baseType);
      if (!mul) return null;

      return qty * mul;
    })();

    const packFromQuantityString = parseQuantityStringToBase(p.quantity, baseType);

    const packAmountBase = packFromProductQuantity ?? packFromQuantityString ?? null;
    const packAmountSource =
      packFromProductQuantity != null
        ? "product_quantity"
        : packFromQuantityString != null
        ? "quantity_string"
        : "none";

    // ---------- PER 100 BASE ----------
    // choose correct nutriment suffix: _100g for food, _100ml for drink
    const suffix = isDrink ? "_100ml" : "_100g";

    const getKcalPer100 = () => {
      const kcalKey = `energy-kcal${suffix}`; // energy-kcal_100g / energy-kcal_100ml
      const kjKey = `energy${suffix}`; // energy_100g / energy_100ml (usually kJ)

      const kcal = toNumber(n[kcalKey]);
      if (kcal != null) return kcal;

      const kj = toNumber(n[kjKey]);
      if (kj != null) return kj / 4.184; // kJ -> kcal

      return null;
    };

    const per100 = {
      calories: getKcalPer100(),
      protein: toNumber(n[`proteins${suffix}`]),
      carbs: toNumber(n[`carbohydrates${suffix}`]),
      fat: toNumber(n[`fat${suffix}`]),
      sugar: toNumber(n[`sugars${suffix}`]),
      fiber: toNumber(n[`fiber${suffix}`]),
      salt: toNumber(n[`salt${suffix}`]),
      sodium: toNumber(n[`sodium${suffix}`]),
    };

    const scale = (factor, decimals = 4) => ({
      calories: round(per100.calories != null ? per100.calories * factor : null, decimals),
      protein: round(per100.protein != null ? per100.protein * factor : null, decimals),
      carbs: round(per100.carbs != null ? per100.carbs * factor : null, decimals),
      fat: round(per100.fat != null ? per100.fat * factor : null, decimals),
      sugar: round(per100.sugar != null ? per100.sugar * factor : null, decimals),
      fiber: round(per100.fiber != null ? per100.fiber * factor : null, decimals),
      salt: round(per100.salt != null ? per100.salt * factor : null, decimals),
      sodium: round(per100.sodium != null ? per100.sodium * factor : null, decimals),
    });

    // ---------- PER 1 BASE UNIT ----------
    // Food: 1g  | Drink: 1ml
    const per1g = !isDrink ? { unit: "g", amount: 1, ...scale(1 / 100, 6) } : null;
    const per1ml = isDrink ? { unit: "ml", amount: 1, ...scale(1 / 100, 6) } : null;

    // ---------- 1 oz / 1 fl oz ----------
    const OZ_IN_G = 28.349523125;
    const FLOZ_IN_ML = 29.5735295625;

    const perOz = !isDrink ? { unit: "oz", amount: 1, ...scale(OZ_IN_G / 100, 4) } : null;
    const perFlOz = isDrink
      ? { unit: "fl oz", amount: 1, ...scale(FLOZ_IN_ML / 100, 4) }
      : null;

    // ---------- PER PACKAGE ----------
    const perPackage =
      packAmountBase != null
        ? {
            unit: isDrink ? "ml" : "g",
            amount: round(packAmountBase, 0),
            ...scale(packAmountBase / 100, 3),
          }
        : null;

    // ---------- RESPONSE ----------
    return res.json({
      type, // "food" | "drink"
      isDrink,
      name: pickName(),
      imageUrl,
      nutriScore: pickNutriScore(), // "A".."E" | null

      pack: {
        amountBase: packAmountBase != null ? round(packAmountBase, 0) : null,
        baseUnit: isDrink ? "ml" : "g",
        source: packAmountSource, // product_quantity | quantity_string | none
        raw: {
          product_quantity: p.product_quantity ?? null,
          product_quantity_unit: p.product_quantity_unit ?? null,
          quantity: p.quantity ?? null,
          serving_quantity: p.serving_quantity ?? null,
          serving_quantity_unit: p.serving_quantity_unit ?? null,
          serving_size: p.serving_size ?? null,
        },
      },

      per1g,
      per1ml,
      perOz,
      perFlOz,
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