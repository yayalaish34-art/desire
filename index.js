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

    const parseQuantityStringToBase = (quantityStr, baseType) => {
      if (!quantityStr || typeof quantityStr !== "string") return null;

      let s = quantityStr.toLowerCase().replace(",", ".").trim();
      s = s.replace(/\s+/g, " ");

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
      return g ? g.toUpperCase() : null;
    };

    // ---------- DETECT TYPE ----------
    const isLiquidUnit = (u) => {
      const x = normalizeUnit(u);
      return (
        x === "ml" ||
        x === "l" ||
        x === "cl" ||
        x === "dl" ||
        x === "floz" ||
        x === "fl oz"
      );
    };

    const isDrink = isLiquidUnit(p.product_quantity_unit);
    const type = isDrink ? "drink" : "food";
    const baseType = isDrink ? "ml" : "g";

    // ---------- PACK ----------
    const packFromProductQuantity = (() => {
      const qty = toNumber(p.product_quantity);
      const unit = p.product_quantity_unit;
      if (qty == null) return null;

      const mul = unitToBaseMultiplier(unit, baseType);
      if (!mul) return null;

      return qty * mul;
    })();

    const packFromQuantityString = parseQuantityStringToBase(p.quantity, baseType);

    const packAmountBase =
      packFromProductQuantity ?? packFromQuantityString ?? null;

    // ---------- NUTRITION ----------
    const suffix = isDrink ? "_100ml" : "_100g";

    const getFoodKcal = () => {
      const kcal = toNumber(n[`energy-kcal${suffix}`]);
      if (kcal != null) return kcal;

      const kj = toNumber(n[`energy${suffix}`]);
      if (kj != null) return kj / 4.184;

      return null;
    };

    const getDrinkKcal = () => {
      const kcal =
        toNumber(n["energy-kcal"]) ??
        toNumber(n["energy-kcal_value"]) ??
        null;

      if (kcal != null) return kcal;

      const kj = toNumber(n["energy"]) ?? toNumber(n["energy_value"]);
      if (kj != null) return kj / 4.184;

      return 0;
    };

    const getDrinkMacro = (key) =>
      toNumber(n[key]) ?? toNumber(n[`${key}_value`]) ?? 0;

    const per100 = !isDrink
      ? {
          calories: getFoodKcal(),
          protein: toNumber(n[`proteins${suffix}`]),
          carbs: toNumber(n[`carbohydrates${suffix}`]),
          fat: toNumber(n[`fat${suffix}`]),
          salt: toNumber(n[`salt${suffix}`]),
        }
      : {
          calories: getDrinkKcal(),
          protein: getDrinkMacro("proteins"),
          carbs: getDrinkMacro("carbohydrates"),
          fat: getDrinkMacro("fat"),
          salt: getDrinkMacro("salt"),
        };

    const scale = (factor, decimals = 4) => ({
      calories: round(per100.calories * factor, decimals),
      protein: round(per100.protein * factor, decimals),
      carbs: round(per100.carbs * factor, decimals),
      fat: round(per100.fat * factor, decimals),
      salt: round(per100.salt * factor, decimals),
    });

    // ---------- FOOD ONLY ----------
    const per1g = !isDrink
      ? { unit: "g", amount: 1, ...scale(1 / 100, 6) }
      : null;

    const perOz = !isDrink
      ? { unit: "oz", amount: 1, ...scale(28.349523125 / 100, 4) }
      : null;

    // ---------- DRINK ONLY ----------
    const perCup250ml = isDrink
      ? { unit: "ml", amount: 250, ...scale(250 / 100, 3) }
      : null;

    // ---------- PACKAGE ----------
    const perPackage =
      packAmountBase != null
        ? {
            unit: isDrink ? "ml" : "g",
            amount: round(packAmountBase, 0),
            ...scale(packAmountBase / 100, 3),
          }
        : null;

    return res.json({
      type,
      isDrink,
      name: pickName(),
      imageUrl,
      nutriScore: pickNutriScore(),

      pack: {
        amountBase: packAmountBase,
        baseUnit: isDrink ? "ml" : "g",
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