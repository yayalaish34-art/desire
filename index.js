import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import OpenAI from "openai";

dotenv.config();
const app = express();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));

// 🔥 ROUTE
app.post("/analyze_image", async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "No image provided" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
      max_tokens: 300,

      // ✅ Force structured JSON output
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "image_analysis",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              response: { type: "string" }, // witty
              summary: { type: "string" },  // exact text in image
            },
            required: ["response", "summary"],
          },
        },
      },

      messages: [
        {
          role: "system",
          content:
            "You are a sharp, witty Gen Z commentator. Keep it concise. Avoid sounding like a therapist. Sound confident and human.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image. Return the JSON fields exactly." },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    });

    // With json_schema, the model returns a JSON string in content.
    const raw = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Model returned invalid JSON",
        raw,
      });
    }

    res.json({
      response: parsed.response || "",
      summary: parsed.summary || "",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error?.message || "Something went wrong",
      code: error?.code || null,
    });
  }
});


app.post("/generate_reply", async (req, res) => {
  try {
    const { summary, mood } = req.body;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content: `
Modes:

FLIRTY – playful tension, teasing, slightly suggestive, confident (never needy). Emojis max 1–2. Open-ended. Avoid depth, seriousness, over-complimenting.

CALM/DIVA – neutral, composed, short, direct. No flirting, humor, emojis, or emotional disclosure.

GENUINE – warm, sincere, emotionally clear. Respectful. No teasing, pressure, or defensiveness.

WITTY – smart concise humor, light irony, confident. Minimal/no emojis. No sarcasm, mockery, vulnerability.

Rules:
- Max 1–2 sentences.
- Return ONE reply only.
- No labels, no explanations.
- No advice framing.
- Never mention the mode.
- Sound natural and human.`,
        },
        { role: "user", content: `Summary: ${summary} | Mood: ${mood}` },
      ],
      max_tokens: 120,
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post("/charm_reply", async (req, res) => {
  try {
    const { message, history, images } = req.body;

    // Debug safe (no base64 dump)
    console.log("charm_reply", {
      hasMessage: !!message,
      historyLen: Array.isArray(history) ? history.length : null,
      imagesLen: Array.isArray(images) ? images.length : null,
      firstImagePrefix:
        Array.isArray(images) && images[0]
          ? String(images[0]).slice(0, 30)
          : null,
    });

    if (!history || !Array.isArray(history)) {
      return res.status(400).json({ error: "Provide 'history' as an array" });
    }

    if (!message && (!images || images.length === 0)) {
      return res.status(400).json({
        error: "Provide 'message' and/or at least one image in 'images'",
      });
    }

    const systemInstruction = `You are Velora AI, an attraction and emotional dynamics mentor.

Your role is to guide women in becoming naturally desirable through confidence, emotional intelligence, and secure energy.

Internal framework:
- True desirability comes from self-value and independence.
- Availability should be natural, not constant.
- Attraction grows through subtle tension, mystery, and emotional depth.
- Social value should be authentic, never manipulative.
- Secure attachment energy is more powerful than playing hard to get.
- Never encourage games, dishonesty, or emotional manipulation.

Behavior rules:
- Respond clearly and intelligently.
- Be calm, insightful, and grounded.
- Do not overuse clichés.
- Avoid extreme or toxic advice.
- Focus on internal shift, not external tricks.
- No meta commentary.

Output rules:
- Return ONLY the final reply message (no labels, no explanations).
- Keep it short, natural, and human.

Tone:
Confident, composed, slightly elegant, emotionally aware.`.trim();

    // ✅ Accept only proper URLs / data URLs
    const imageParts = (Array.isArray(images) ? images : [])
      .filter((u) => typeof u === "string" && u.trim().length > 0)
      .map((u) => u.trim())
      .filter((u) => u.startsWith("http") || u.startsWith("data:image/"))
      .slice(0, 2) // 🔥 תתחיל עם 1-2 כדי לא להפיל
      .map((url) => ({
        type: "image_url",
        image_url: { url }, // MUST be url
      }));

    const userContent = [
      ...(message ? [{ type: "text", text: message }] : []),
      ...imageParts,
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.9,
      max_tokens: 160,
      messages: [
        { role: "system", content: systemInstruction },
        ...history,
        { role: "user", content: userContent },
      ],
    });

    const reply = response?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({
        error: "No reply returned from model",
        raw: response,
      });
    }

    return res.json({ reply });
  } catch (err) {
    // ✅ show the REAL OpenAI error in response + logs
    console.error("charm_reply error:", err?.message);
    console.error(err?.response?.data || err);

    return res.status(500).json({
      error: err?.message || "Something went wrong",
      code: err?.code || null,
      type: err?.type || null,
    });
  }
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
