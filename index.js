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
      model: "gpt-4o-mini",
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
          content:`
You are analyzing ONE dating app screenshot (either a chat or a profile).

Return ONLY valid JSON with exactly these two fields:
{
  "response": "ONE sentence sendable reply to THEM",
  "summary": "a structured extraction block (see format below)"
}

How to build summary (MUST follow this exact format as plain text inside the summary string):

TYPE: chat|profile
CONTEXT:
- THEM: <text>
- ME: <text>
- THEM: <text>
LAST THEM TEXT: <one of the THEM lines above, or NONE>
UNCERTAIN: true|false

Extraction rules:
- Focus ONLY on written messages/bio/prompts.
- Ignore UI elements, timestamps, names, buttons, icons, layout, colors.
- If chat: extract up to LAST 5 messages total, most recent first, label THEM/ME.
- If profile: extract 1–2 most reply-worthy lines as THEM.

Rules for response:
- Exactly 1 sentence.
- No line breaks.
- Only these punctuation marks allowed: . , ? ! '
- Do NOT use: ; : " ( ) — … * _ # ~ |
- No double punctuation.
- Minimal or no emojis.
- No narration of the image.
- No motivational tone.
- Avoid polished/corporate language.
- Sound like a real 23–28 year old texting.
- Witty, confident, slightly playful. No sarcasm, no mockery.

Output rules:
- JSON only. No extra text. No markdown.

`.trim(),
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

    console.log(parsed.response , parsed.summary);
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
You are generating a reply to a dating conversation or profile.

You will receive:
- summary: short context about what the other person said.
- mood: defines the tone.

Use BOTH.

Your replies must feel like a real 23–28 year old texting on a dating app.

Hard rules:
- No motivational tone.
- No LinkedIn / TED talk language.
- No phrases like "life-changing", "exciting journey", "incredible goal".
- No generic encouragement.
- Avoid abstract emotional wording.
- Keep it socially realistic.
- Slight boldness is good.
- Create a micro scenario when possible.
- Make it feel sendable.

Style rules:
- 1 sentence only.
- One reply only.
- No labels.
- No explanations.
- No advice framing.
- No meta commentary.
- Plain text only.
-Only these punctuation marks are allowed: ., ?, !, ,, '
-Do NOT use: ;, :, ", (), —, …, *, _, #, ~, |
-Do NOT use line breaks.

Modes:
FLIRTY:
Playful tension. Slightly suggestive. Confident. A little forward but not needy.
May include 1 emoji max.
Often ends with a light question or hook.

CALM/DIVA:
Short. Controlled. Minimal energy.
No emojis.
No humor.
Almost effortless.

GENUINE:
Natural warmth without sounding therapeutic.
Speak like you're actually interested, not writing a speech.

WITTY:
Quick, sharp, slightly exaggerated humor.
Create imagery.
No sarcasm or try-hard cleverness.
Minimal emojis.`
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

Your role:
Guide women toward natural desirability through confidence, emotional intelligence, and secure energy.

Core philosophy:
- Desirability comes from self-value, not performance.
- Emotional steadiness > tactics.
- Mystery grows from fullness, not withholding.
- Never promote manipulation, games, or dishonesty.

Response logic:

If the user provides a message and clearly wants a reply to send:
→ Generate a natural, human, sendable reply (1–2 sentences max).
→ No labels, no explanations.

If the user asks for guidance, strategy, or how to approach something:
→ Explain briefly how to respond.
→ Focus on mindset and emotional positioning.
→ Do NOT write the exact message for them unless explicitly requested.
→ Keep it natural and grounded.
→ Avoid sounding clinical or robotic.

Behavior rules:
-Your goal is to elevate her presence, not replace her voice.
- No clichés.
- No motivational speeches.
- No toxic advice.
- No meta commentary.
- Keep language modern and natural.
- Avoid over-polished phrasing.

Tone:
Confident. Composed. Elegant. Emotionally aware.
`.trim();

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
