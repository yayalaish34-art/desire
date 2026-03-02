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

      const m = s.match(
        /(\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\b/
      );
      if (!m) return null;

      const amount = Number(m[1]);
      const unit = m[3];
      const mul = unitToBaseMultiplier(unit, baseType);
      if (!mul) return null;
      return amount * mul;
    };

    // serving_size often: "1 slice (28 g)" or "(250 ml)"
    const parseServingSizeToBase = (servingSizeStr, baseType) => {
      if (!servingSizeStr || typeof servingSizeStr !== "string") return null;
      let s = servingSizeStr.toLowerCase().replace(",", ".").trim();

      // prefer the value inside parentheses if exists
      const paren = s.match(/\((\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\)/);
      const m = paren || s.match(/(\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\b/);
      if (!m) return null;

      const amount = Number(m[1]);
      const unit = m[3];
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
      return x === "ml" || x === "l" || x === "cl" || x === "dl" || x === "floz" || x === "fl oz";
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
    const packAmountBase = packFromProductQuantity ?? packFromQuantityString ?? null;

    // ---------- SERVING SIZE (in base units) ----------
    const servingQty = toNumber(p.serving_quantity);
    const servingUnit = p.serving_quantity_unit;
    const servingFromServingQuantity =
      servingQty != null
        ? (() => {
            const mul = unitToBaseMultiplier(servingUnit, baseType);
            return mul ? servingQty * mul : null;
          })()
        : null;

    const servingFromServingSize = parseServingSizeToBase(p.serving_size, baseType);

    const servingAmountBase = servingFromServingQuantity ?? servingFromServingSize ?? null;

    // ---------- NUTRIMENTS via *_serving ----------
    // pulls “per serving” values directly from nutriments object
    const perServing = {
      calories: toNumber(n["energy-kcal_serving"]),
      protein: toNumber(n["proteins_serving"]),
      carbs: toNumber(n["carbohydrates_serving"]),
      fat: toNumber(n["fat_serving"]),
      salt: toNumber(n["salt_serving"]),
    };

    // If calories missing but kJ serving exists, convert:
    if (perServing.calories == null) {
      const kjServing = toNumber(n["energy-kj_serving"]) ?? toNumber(n["energy_serving"]);
      if (kjServing != null) perServing.calories = kjServing / 4.184;
    }

    const hasAnyServing =
      perServing.calories != null ||
      perServing.protein != null ||
      perServing.carbs != null ||
      perServing.fat != null ||
      perServing.salt != null;

    // ---------- BACKUP per100 (only if serving missing) ----------
    const suffix = isDrink ? "_100ml" : "_100g";
    const per100Backup = {
      calories: toNumber(n[`energy-kcal${suffix}`]) ?? (() => {
        const kj = toNumber(n[`energy${suffix}`]) ?? toNumber(n[`energy-kj${suffix}`]);
        return kj != null ? kj / 4.184 : null;
      })(),
      protein: toNumber(n[`proteins${suffix}`]),
      carbs: toNumber(n[`carbohydrates${suffix}`]),
      fat: toNumber(n[`fat${suffix}`]),
      salt: toNumber(n[`salt${suffix}`]),
    };

    // choose base source
    const base = hasAnyServing ? { ...perServing, _basis: "serving" } : { ...per100Backup, _basis: "per100" };

    // ---------- SCALE HELPERS ----------
    const scaleObj = (obj, factor, decimals = 4) => ({
      calories: obj.calories == null ? null : round(obj.calories * factor, decimals),
      protein: obj.protein == null ? null : round(obj.protein * factor, decimals),
      carbs: obj.carbs == null ? null : round(obj.carbs * factor, decimals),
      fat: obj.fat == null ? null : round(obj.fat * factor, decimals),
      salt: obj.salt == null ? null : round(obj.salt * factor, decimals),
    });

    // ---------- OUTPUTS (keep same fields) ----------
    // per1g/perOz only makes sense for food; for drinks keep null like before
    // If base is per serving, we can still compute per-gram by dividing by serving grams (if we have it).
    const per1g = !isDrink
      ? (() => {
          if (base._basis === "serving") {
            if (servingAmountBase == null || servingAmountBase <= 0) return null;
            return {
              unit: "g",
              amount: 1,
              ...scaleObj(base, 1 / servingAmountBase, 6),
            };
          } else {
            // per100 -> per1g is /100
            return { unit: "g", amount: 1, ...scaleObj(base, 1 / 100, 6) };
          }
        })()
      : null;

    const perOz = !isDrink
      ? (() => {
          const OZ_G = 28.349523125;
          if (base._basis === "serving") {
            if (servingAmountBase == null || servingAmountBase <= 0) return null;
            return {
              unit: "oz",
              amount: 1,
              ...scaleObj(base, OZ_G / servingAmountBase, 4),
            };
          } else {
            return { unit: "oz", amount: 1, ...scaleObj(base, OZ_G / 100, 4) };
          }
        })()
      : null;

    const perCup250ml = isDrink
      ? (() => {
          // If base is per serving and serving is known in ml -> we can compute 250ml
          if (base._basis === "serving") {
            if (servingAmountBase == null || servingAmountBase <= 0) return null;
            return { unit: "ml", amount: 250, ...scaleObj(base, 250 / servingAmountBase, 3) };
          } else {
            return { unit: "ml", amount: 250, ...scaleObj(base, 250 / 100, 3) };
          }
        })()
      : null;

    const perPackage =
      packAmountBase != null
        ? (() => {
            if (base._basis === "serving") {
              if (servingAmountBase == null || servingAmountBase <= 0) {
                // no serving grams/ml -> can't scale serving to package
                return null;
              }
              const factor = packAmountBase / servingAmountBase;
              return {
                unit: isDrink ? "ml" : "g",
                amount: round(packAmountBase, 0),
                ...scaleObj(base, factor, 3),
              };
            } else {
              // per100 -> scale by pack/100
              const factor = packAmountBase / 100;
              return {
                unit: isDrink ? "ml" : "g",
                amount: round(packAmountBase, 0),
                ...scaleObj(base, factor, 3),
              };
            }
          })()
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