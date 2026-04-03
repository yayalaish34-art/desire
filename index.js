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

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------- HELPERS ----------------
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clampScore(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function clampSkinAge(value, fallback = 25) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(10, Math.min(80, Math.round(num)));
}

function normalizeFaceAnalysis(parsed) {
  return {
    skin_score: clampScore(parsed?.skin_score, 75),
    skin_age: clampSkinAge(parsed?.skin_age, 25),
    metrics: {
      hydration: clampScore(parsed?.metrics?.hydration, 75),
      texture: clampScore(parsed?.metrics?.texture, 75),
      firmness: clampScore(parsed?.metrics?.firmness, 75),
      smoothness: clampScore(parsed?.metrics?.smoothness, 75),
      glow_level: clampScore(parsed?.metrics?.glow_level, 75),
      eye_freshness: clampScore(parsed?.metrics?.eye_freshness, 75),
      face_definition: clampScore(parsed?.metrics?.face_definition, 75),
      symmetry: clampScore(parsed?.metrics?.symmetry, 75),
    },
  };
}

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// ---------------- UPLOAD SETUP ----------------
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const safe =
        Date.now() + "-" + file.originalname.replace(/[^\w.\-]/g, "_");
      cb(null, safe);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------------- NUTRITION PROMPT ----------------
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

// ---------------- FACE ANALYSIS PROMPT ----------------
const FACE_SYSTEM_PROMPT = `
You are a face analysis AI for a feminine glow up app.

Your role is to gently analyze a user’s face.

Your tone should feel like a soft, supportive beauty coach.

TONE
- feminine
- soft
- warm
- supportive
- encouraging
- slightly aspirational
- never harsh
- never critical
- never overly clinical

IMPORTANT
Focus only on areas that can realistically improve with:
- daily habits
- simple routines
- face exercises

Do NOT include:
- acne
- medical skin conditions
- anything that cannot change with habits

FACE METRICS
Analyze the face and return the following scores from 0 to 100:

- skin_score
- hydration
- texture
- firmness
- smoothness
- glow_level
- eye_freshness
- face_definition
- symmetry

All values must be integers.

SCORING SCALE (VERY IMPORTANT)

0–20 = very low / weak
21–40 = below average
41–60 = average
61–80 = good
81–100 = excellent

Each score MUST reflect visible differences.

SCORING BEHAVIOR (CRITICAL)

- Scores MUST vary across metrics
- Avoid giving similar values to all metrics
- Use the full 0–100 range when justified
- Each metric MUST be based on a different visible cue
- If uncertain, choose a direction (slightly lower or higher), NOT the middle

DISTRIBUTION RULE (VERY IMPORTANT)

- It is allowed for some metrics to fall within 45–60
- HOWEVER, not all metrics can be in this range
- You MUST ensure distribution:
  - At least 2 metrics must be BELOW 40
  - At least 2 metrics must be ABOVE 75
- The remaining metrics can fall in the middle range
- Do NOT keep all metrics close together
- Even if multiple metrics look similar, you MUST still separate them

GLOW LEVEL RULE (HARD CONSTRAINT)

- glow_level MUST be above 45-75

METRIC HINTS

- skin_score → overall skin impression, not an average
- hydration → plumpness, bounce
- texture → pores, irregularity
- smoothness → evenness
- firmness → lifted vs softer
- glow_level → radiance
- eye_freshness → brightness, alertness
- face_definition → contours
- symmetry → balance

SKIN AGE
Return:
- skin_age → realistic estimated skin age

OUTPUT

Return JSON only in this exact format:

{
  "skin_score": 0,
  "skin_age": 0,
  "metrics": {
    "hydration": 0,
    "texture": 0,
    "firmness": 0,
    "smoothness": 0,
    "glow_level": 0,
    "eye_freshness": 0,
    "face_definition": 0,
    "symmetry": 0
  }
}

RULES
- Return valid JSON only
- No markdown
- No explanations
- No extra text
- All scores must be integers
- Use simple English
- Keep tone soft and supportive
- Do not mention acne or medical issues

If no face is clearly visible, return:
{
  "error": "no_face_detected"
}
`.trim();

// ---------------- FACE ANALYSIS MODEL HELPER ----------------
async function runFaceAnalysis(imageBase64) {
  const requestBody = {
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: FACE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Analyze this face for a feminine glow up app.",
          },
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

  try {
    return await client.chat.completions.create(requestBody);
  } catch (error) {
    console.log("gpt-4.1-mini failed, switching to gpt-4.1-nano...");
    return await client.chat.completions.create({
      ...requestBody,
      model: "gpt-4.1-nano",
    });
  }
}

// ---------------- ANALYZE FACE ROUTE ----------------
app.post("/analyze_face", async (req, res) => {
  try {
    const imageBase64 = req.body?.imageBase64;

    if (!isNonEmptyString(imageBase64)) {
      return res.status(400).json({
        success: false,
        error: "missing_image_base64",
      });
    }

    const response = await runFaceAnalysis(imageBase64.trim());
    const content = response?.choices?.[0]?.message?.content;

    if (!isNonEmptyString(content)) {
      return res.status(502).json({
        success: false,
        error: "empty_model_response",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error("analyze_face invalid JSON:", content);
      return res.status(502).json({
        success: false,
        error: "invalid_json_from_model",
      });
    }

    if (parsed?.error === "no_face_detected") {
      return res.status(200).json({
        success: false,
        error: "no_face_detected",
      });
    }

    const analysis = normalizeFaceAnalysis(parsed);

    return res.status(200).json({
      success: true,
      analysis,
    });
  } catch (error) {
    console.error("analyze_face error:", error);

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "server_error",
    });
  }
});

// ---------------- ANALYZE COLOR ROUTE ----------------
// ---------------- ANALYZE COLOR ROUTE ----------------
app.post("/analyze_color", async (req, res) => {
  try {
    const body = req.body || {};

    const imageUrl = body.imageUrl;
    const base64Image = body.base64Image;

    if (!imageUrl && !base64Image) {
      return res.status(400).json({
        success: false,
        error: "missing_image",
      });
    }

    console.log("analyze_color called");
    console.log("has imageUrl:", !!imageUrl);
    console.log("has base64Image:", !!base64Image);
    console.log("base64 length:", base64Image?.length || 0);

    const imagePart = imageUrl
      ? {
          type: "image_url",
          image_url: { url: imageUrl },
        }
      : {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64Image.trim()}`,
          },
        };

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a personal color analysis expert.

Analyze the person in the image and return JSON only.

Return this exact structure:

{
"palette": {
  "title": "Light Summer",
  "description": "A concise explanation written directly to you, based on your visible features (undertone, contrast, hair, eyes, skin softness) in 3 short sentences."
},
"metal": {
  "title": "Silver",
  "description": "A concise explanation written directly to you, explaining why this metal complements your undertone and overall coloring in exactly 2 short sentences."
},
  "bestColors": [
    { "name": "Soft Rose", "hex": "#D8A7B1" },
    { "name": "Dusty Blue", "hex": "#8CA9C7" },
    { "name": "Cool Mauve", "hex": "#B79AC8" },
    { "name": "Soft Lavender", "hex": "#C7B4E2" },
    { "name": "Muted Teal", "hex": "#6FA7A1" },
    { "name": "Light Berry", "hex": "#B76E8A" }
  ],
  "avoidColors": [
    { "name": "Bright Orange", "hex": "#FF7A00" },
    { "name": "Neon Yellow", "hex": "#F6FF00" },
    { "name": "Harsh Black", "hex": "#111111" },
    { "name": "Warm Mustard", "hex": "#C89B00" }
  ]
}

Rules:
- Return valid JSON only
- No markdown
- No explanations outside JSON
- bestColors must contain exactly 6 items
- avoidColors must contain exactly 4 items
- Each color must have:
  - name: string
  - hex: valid 7-character hex color starting with #

Tone & Style:
- Speak directly to the user (use "you", "your")
- Tone should feel supportive, elevated, aesthetic, and slightly luxurious
- Encourage the user subtly (make them feel good about their features)

Analysis Requirements:
- Base everything on visible features only (skin undertone, contrast, hair, eyes, softness/brightness)
- Do NOT make generic claims — every statement must connect to what is visible in the face
- Explain WHY the palette works (e.g. softness vs brightness, warm vs cool harmony)

Color Explanation:
- Briefly explain how the recommended colors interact with your face (e.g. brighten your skin, reduce shadows, enhance eye color, create harmony)
- Avoid vague statements — keep it grounded and visual

Extra Value (important):
- Include one subtle practical insight inside the palette description (for example: what happens when you wear the wrong colors vs the right ones, or how these colors will make your features stand out naturally)

- Pick only one metal: "Silver" or "Gold"
          `.trim(),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this face and return personal color analysis JSON.",
            },
            imagePart,
          ],
        },
      ],
    });

    const content = response?.choices?.[0]?.message?.content;

    if (!isNonEmptyString(content)) {
      return res.status(502).json({
        success: false,
        error: "empty_model_response",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error("analyze_color invalid JSON:", content);
      return res.status(502).json({
        success: false,
        error: "invalid_json_from_model",
        raw: content,
      });
    }

    // basic normalization / validation
    const palette = {
      title: isNonEmptyString(parsed?.palette?.title)
        ? parsed.palette.title.trim()
        : "Personal Palette",
      description: isNonEmptyString(parsed?.palette?.description)
        ? parsed.palette.description.trim()
        : "A soft, flattering palette selected for your features.",
    };

    const metalTitle =
      parsed?.metal?.title === "Gold" ? "Gold" : "Silver";

    const metal = {
      title: metalTitle,
      description: isNonEmptyString(parsed?.metal?.description)
        ? parsed.metal.description.trim()
        : `${metalTitle} complements your overall coloring best.`,
    };

    const isValidHex = (value) =>
      typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);

    const normalizeColorArray = (arr, fallback) => {
      if (!Array.isArray(arr)) return fallback;

      return arr
        .filter(
          (item) =>
            isNonEmptyString(item?.name) &&
            isValidHex(item?.hex)
        )
        .map((item) => ({
          name: item.name.trim(),
          hex: item.hex.toUpperCase(),
        }));
    };

    const fallbackBestColors = [
      { name: "Soft Rose", hex: "#D8A7B1" },
      { name: "Dusty Blue", hex: "#8CA9C7" },
      { name: "Cool Mauve", hex: "#B79AC8" },
      { name: "Soft Lavender", hex: "#C7B4E2" },
      { name: "Muted Teal", hex: "#6FA7A1" },
      { name: "Light Berry", hex: "#B76E8A" },
    ];

    const fallbackAvoidColors = [
      { name: "Bright Orange", hex: "#FF7A00" },
      { name: "Neon Yellow", hex: "#F6FF00" },
      { name: "Harsh Black", hex: "#111111" },
      { name: "Warm Mustard", hex: "#C89B00" },
    ];

    let bestColors = normalizeColorArray(parsed?.bestColors, fallbackBestColors);
    let avoidColors = normalizeColorArray(
      parsed?.avoidColors,
      fallbackAvoidColors
    );

    if (bestColors.length < 6) {
      bestColors = fallbackBestColors;
    } else {
      bestColors = bestColors.slice(0, 6);
    }

    if (avoidColors.length < 4) {
      avoidColors = fallbackAvoidColors;
    } else {
      avoidColors = avoidColors.slice(0, 4);
    }

    return res.status(200).json({
      success: true,
      palette,
      metal,
      bestColors,
      avoidColors,
    });
  } catch (error) {
    console.error("analyze_color error full:", error);

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "failed_to_analyze_color",
    });
  }
});

// ---------------- ANALYZE BODY SHAPE ROUTE ----------------
app.post("/analyze_body_shape", async (req, res) => {
  try {
    const body = req.body || {};

    const imageUrl = body.imageUrl;
    const base64Image = body.base64Image;

    if (!imageUrl && !base64Image) {
      return res.status(400).json({
        error: "Missing imageUrl or base64Image",
      });
    }

    console.log("analyze_body_shape called");
    console.log("has imageUrl:", !!imageUrl);
    console.log("has base64Image:", !!base64Image);
    console.log("base64 length:", base64Image?.length || 0);

    const imagePart = imageUrl
      ? {
          type: "image_url",
          image_url: { url: imageUrl },
        }
      : {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64Image}`,
          },
        };

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "body_shape_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              bodyShape: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                },
                required: ["title", "description"],
              },
              stylingTips: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tops: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "string" },
                  },
                  bottoms: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "string" },
                  },
                  dresses: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "string" },
                  },
                  accessories: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "string" },
                  },
                },
                required: ["tops", "bottoms", "dresses", "accessories"],
              },
            },
            required: ["bodyShape", "stylingTips"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content: `
You are a feminine body shape styling assistant.

Analyze the person in the image and return:

1. bodyShape
- title: a short body shape name like "Hourglass", "Pear", "Rectangle", "Inverted Triangle", or "Apple"
- description: around the same length and style as:
"Balanced proportions with a well-defined waist. Bust and hips are approximately the same width, while the waist is significantly smaller."

2. stylingTips
Return exactly 3 tips for each:
- tops
- bottoms
- dresses
- accessories

Rules:
- Keep tone elegant, supportive, feminine, and app-friendly
- Tips should be short, practical, and visually clear
- Do not mention weight loss or body criticism
- Do not add extra fields
- Return valid JSON only
          `.trim(),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this body shape and return JSON.",
            },
            imagePart,
          ],
        },
      ],
    });

    const content = completion?.choices?.[0]?.message?.content;

    if (!isNonEmptyString(content)) {
      return res.status(502).json({
        error: "No response from model",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error("analyze_body_shape invalid JSON:", content);
      return res.status(502).json({
        error: "Invalid JSON returned from model",
      });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("analyze_body_shape error full:", error);
    return res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to analyze body shape",
    });
  }
});

// ---------------- ANALYZE TEXT ROUTE ----------------
app.post("/analyze_text", async (req, res) => {
  try {
    const { text } = req.body || {};

    if (!isNonEmptyString(text)) {
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

    const jsonText = response?.choices?.[0]?.message?.content?.trim();

    if (!isNonEmptyString(jsonText)) {
      return res.status(502).json({ error: "Model returned empty output" });
    }

    const parsed = JSON.parse(jsonText);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("analyze_text error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
});

// ---------------- ANALYZE AUDIO ROUTE ----------------
app.post("/analyze_audio", upload.single("file"), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!filePath) {
      return res
        .status(400)
        .json({ error: "Missing audio file. Use field name: file" });
    }

    const transcription = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(filePath),
      response_format: "json",
    });

    const transcriptText = transcription?.text?.trim();

    if (!isNonEmptyString(transcriptText)) {
      return res.status(502).json({ error: "Empty transcription result" });
    }

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

    const jsonText = response?.choices?.[0]?.message?.content?.trim();

    if (!isNonEmptyString(jsonText)) {
      return res.status(502).json({ error: "Model returned empty output" });
    }

    const parsed = JSON.parse(jsonText);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("analyze_audio error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

// ---------------- ANALYZE FOOD IMAGE ROUTE ----------------
app.post("/analyze", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};

    if (!isNonEmptyString(imageBase64)) {
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
}`.trim();

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

    const content = response?.choices?.[0]?.message?.content;

    if (!isNonEmptyString(content)) {
      return res.status(502).json({ error: "Empty response from model" });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error("analyze invalid JSON:", content);
      return res
        .status(500)
        .json({ error: "Invalid JSON returned from model" });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("analyze error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Server error",
    });
  }
});

// ---------------- BARCODE ROUTE ----------------
app.post("/barcode", async (req, res) => {
  try {
    const { barcode } = req.body || {};

    if (!barcode) {
      return res.status(400).json({ error: "barcode is required" });
    }

    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;

    const r = await fetch(url, {
      headers: { "User-Agent": "EatLessLab/1.0 (contact: you@example.com)" },
    });

    if (!r.ok) {
      return res.status(502).json({ error: "OpenFoodFacts error" });
    }

    const data = await r.json();
    if (data?.status !== 1 || !data?.product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const p = data.product;
    const n = p.nutriments || {};

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
      return (
        x === "ml" ||
        x === "l" ||
        x === "cl" ||
        x === "dl" ||
        x === "floz" ||
        x === "fl oz"
      );
    };

    const unitToMlOrGMultiplier = (unit) => {
      const u = normalizeUnit(unit);
      if (!u) return null;

      if (u === "g") return 1;
      if (u === "kg") return 1000;
      if (u === "mg") return 0.001;
      if (u === "oz") return 28.349523125;

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

      const m = s.match(
        /(\d+(\.\d+)?)\s*(kg|g|mg|ml|l|cl|dl|fl oz|floz|oz)\b/
      );
      if (!m) return null;

      const amount = Number(m[1]);
      const unit = m[3];
      const mul = unitToMlOrGMultiplier(unit);
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

    const imageUrl =
      p.image_front_url ||
      p.image_front_small_url ||
      p.image_url ||
      p.image_small_url ||
      null;

    const isDrink = isLiquidUnit(p.product_quantity_unit);
    const type = isDrink ? "drink" : "food";

    const packFromProductQuantity = (() => {
      const qty = toNumber(p.product_quantity);
      if (qty == null) return null;
      const mul = unitToMlOrGMultiplier(p.product_quantity_unit);
      if (!mul) return null;
      return qty * mul;
    })();

    const packFromQuantityString = parseQuantityString(p.quantity);
    const packAmountBase =
      packFromProductQuantity ?? packFromQuantityString ?? null;
    const packBaseUnit = isDrink ? "ml" : "g";

    const getPer100 = () => {
      const pick = (key) => {
        if (isDrink) {
          return (
            toNumber(n[`${key}_100ml`]) ?? toNumber(n[`${key}_100g`]) ?? null
          );
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
      calories:
        per100.calories == null ? null : round(per100.calories * factor, decimals),
      protein:
        per100.protein == null ? null : round(per100.protein * factor, decimals),
      carbs:
        per100.carbs == null ? null : round(per100.carbs * factor, decimals),
      fat: per100.fat == null ? null : round(per100.fat * factor, decimals),
      salt: per100.salt == null ? null : round(per100.salt * factor, decimals),
    });

    const per1g = !isDrink ? { unit: "g", amount: 1, ...scale(1 / 100, 6) } : null;

    const perOz = !isDrink
      ? { unit: "oz", amount: 1, ...scale(28.349523125 / 100, 4) }
      : null;

    const perCup250ml = isDrink
      ? { unit: "ml", amount: 250, ...scale(250 / 100, 3) }
      : null;

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
    console.error("barcode error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);