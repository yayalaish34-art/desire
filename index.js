// index.js
// One-file backend (ESM) — Express + CORS + dotenv + OpenAI
// Install: npm i express cors dotenv openai
// Run: node index.js  (make sure package.json has "type": "module")
// Env: OPENAI_API_KEY=..., PORT=3000 (optional)

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

// Health check (optional)
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// POST /api/calories/burned
// Body:
// {
//   workoutType: "weight lifting" | "run" (optional if description provided)
//   description: string (optional if workoutType provided)
//   durationMinutes?: number
//   weightKg?: number
//   age?: number
//   sex?: "male" | "female"
//   intensity?: "low" | "moderate" | "high"
// }
app.post("/api/calories/burned", async (req, res) => {
  try {
    const {
      workoutType,
      description,
      durationMinutes,
      weightKg,
      age,
      sex,
      intensity,
    } = req.body || {};

    // Minimal validation (JS-only, no zod)
    if (!workoutType && !description) {
      return res
        .status(400)
        .json({ error: "Provide workoutType or description." });
    }

    const allowedTypes = new Set(["weight lifting", "run"]);
    if (workoutType && !allowedTypes.has(workoutType)) {
      return res.status(400).json({
        error: 'workoutType must be "weight lifting" or "run".',
      });
    }

    const allowedSex = new Set(["male", "female"]);
    if (sex && !allowedSex.has(sex)) {
      return res.status(400).json({ error: 'sex must be "male" or "female".' });
    }

    const allowedIntensity = new Set(["low", "moderate", "high"]);
    if (intensity && !allowedIntensity.has(intensity)) {
      return res.status(400).json({
        error: 'intensity must be "low", "moderate", or "high".',
      });
    }

    // Build prompt
    const input = [
      {
        role: "system",
        content:
          "You estimate calories burned from workouts. Be realistic and conservative. Do not invent specific details; if something is missing, assume a reasonable default and explicitly mention the assumption. Output MUST match the JSON schema exactly. The description MUST be exactly 3 sentences.",
      },
      {
        role: "user",
        content: [
          "Calculate calories burned for this workout.",
          "Return JSON with:",
          "- calories: number (no units)",
          "- description: exactly 3 sentences explaining how it was calculated",
          "",
          `workoutType: ${workoutType ?? "N/A"}`,
          `description: ${description ?? "N/A"}`,
          `durationMinutes: ${durationMinutes ?? "N/A"}`,
          `weightKg: ${weightKg ?? "N/A"}`,
          `age: ${age ?? "N/A"}`,
          `sex: ${sex ?? "N/A"}`,
          `intensity: ${intensity ?? "N/A"}`,
        ].join("\n"),
      },
    ];

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "calories_burned",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["calories", "description"],
            properties: {
              calories: { type: "number" },
              description: { type: "string" },
            },
          },
        },
      },
      max_output_tokens: 200,
    });

    const text = (response.output_text || "").trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Model returned non-JSON output.",
        raw: text,
      });
    }

    // Ensure output shape
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.calories !== "number" ||
      typeof parsed.description !== "string"
    ) {
      return res.status(502).json({
        error: "Model returned JSON but not in the expected shape.",
        raw: parsed,
      });
    }

    // Optional: enforce exactly 3 sentences (soft enforcement)
    // If you want strict enforcement, tell me and I'll hard-enforce with retry.
    return res.json({
      calories: parsed.calories,
      description: parsed.description,
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