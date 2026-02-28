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

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// POST /api/calories/burned
// Body:
// {
//   workoutType?: "weight lifting" | "weights" | "run"  (both accepted)
//   description?: string
//   duration?: number   (training time in minutes)
//   weightKg?: number
//   age?: number
//   sex?: "male" | "female"
//   intensity?: "low" | "moderate" | "medium" | "high"  (medium = moderate)
// }

app.post("/api/calories/burned", async (req, res) => {
  try {
    let {
      workoutType,
      description,
      duration,
      weightKg,
      age,
      sex,
      intensity,
    } = req.body || {};

    if (!workoutType && !description) {
      return res
        .status(400)
        .json({ error: "Provide workoutType or description." });
    }

    // Validate duration
    if (duration !== undefined) {
      if (typeof duration !== "number" || duration <= 0) {
        return res.status(400).json({
          error: "duration must be a positive number (minutes).",
        });
      }
    }

    const allowedTypes = new Set(["weights", "run"]);
    if (workoutType && !allowedTypes.has(workoutType)) {
      return res.status(400).json({
        error: 'workoutType must be "weights" or "run".',
      });
    }

    const allowedSex = new Set(["male", "female"]);
    if (sex && !allowedSex.has(sex)) {
      return res.status(400).json({ error: 'sex must be "male" or "female".' });
    }

    const allowedIntensity = new Set(["low", "medium", "high"]);
    if (intensity && !allowedIntensity.has(intensity)) {
      return res.status(400).json({
        error: 'intensity must be "low", "medium", or "high".',
      });
    }

    const input = [
      {
        role: "system",
        content:
          "You estimate calories burned from workouts. Be realistic and conservative. If something is missing, assume a reasonable default and explicitly mention the assumption. The variable 'duration' represents the total workout time in minutes. Output MUST match the JSON schema exactly. The description MUST be exactly 3 sentences.",
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
          `duration (minutes): ${duration ?? "N/A"}`,
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