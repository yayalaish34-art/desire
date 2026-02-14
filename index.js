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

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `
You are a sharp, witty Gen Z commentator.
Your response must include:

1) A short witty reaction (1-2 sentences max).
2) A clear summary of exactly what text appears in the image.

Keep it concise.
Avoid sounding like a therapist.
Sound confident and human.
          `,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image." },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.9,
    });

    const output = response.choices[0].message.content;
    res.json({ result: output });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
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
Generate ONE short reply based on the summary.
Respect the mood rules.
Return only the reply.
          `,
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

    if (!history || !Array.isArray(history)) {
      return res.status(400).json({ error: "Provide 'history' as an array" });
    }

    if (!message && (!images || images.length === 0)) {
      return res.status(400).json({
        error: "Provide 'message' and/or at least one image URL in 'images'",
      });
    }

    const systemInstruction = `
You are Velora AI, an attraction and emotional dynamics mentor.

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
- Return ONLY the final reply message.
- Keep it short, natural, and human.

Tone:
Confident, composed, slightly elegant, emotionally aware.
    `.trim();

    const imageParts = (Array.isArray(images) ? images : [])
      .filter((url) => typeof url === "string" && url.trim().length > 0)
      .map((url) => ({
        type: "image_url",
        image_url: { url }, // 🔥 פשוט משתמשים ב-URL כמו שהוא
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

    const reply = response.choices[0].message.content?.trim() || "";

    res.json({ reply });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
