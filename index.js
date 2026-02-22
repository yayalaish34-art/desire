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

app.post("/wake", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { text, timeLeft } = req.body ?? {};

    if (!text || typeof text !== "string") {
      send({ type: "error", message: "Missing 'text' (string)." });
      return res.end();
    }

    const system = `
You are writing a bold wake-up message to someone who is overthinking.
You will receive a variable called "timeLeft".

Rules about timeLeft:
If timeLeft exists (example: "240 months" or "960 weeks"):
The FIRST sentence MUST start exactly with that value.
Example: "240 months."
Do NOT modify the number.
If timeLeft is null or missing:
Do NOT mention any exact numbers.
Speak about time in a general way only.
The message must:
Make time feel counted, not infinite.
Create urgency without being dark or depressing.
Expose hesitation.
Shrink the problem.
Restore boldness.
Tone: Sharp. Confident. Minimal. Emotionally intense but not dramatic.

Rules:
Use direct, everyday language.

Include one sentence that minimizes the situation using practical logic.
Reduce the fear to its simplest possible outcome.
Show that the worst-case scenario is small and temporary.
The minimization must be realistic, grounded, and highly confident.

No metaphors.
No poetic phrasing.
No abstract imagery.
No dramatic expressions.
Avoid elevated vocabulary.
Use common conversational wording only.

Speak like a brutally honest friend.
It should feel like a smart 20-year-old talking.
Keep sentences grounded and practical.
Prefer simple, blunt statements.
No therapy tone.
No clichés.
No long paragraphs.
No comfort language.
No moral lectures.
Use short punchy sentences.
7–8 sentences total.
Each sentence must end with ".", "!" or "?".

Insert 3–4 highlighted two-word or three-word phrases wrapped like this: $two words$.
The highlights must feel intentional, not decorative.

The FINAL sentence MUST be fully wrapped like this: $Your final sentence here.$
The FINAL sentence must contain exactly ONE sentence.
Inside $...$ there must be only one ending punctuation mark.
No line breaks inside $...$.
No multiple sentences inside $...$.
Everything inside $...$ must be one complete sentence.

If the user mentions death, suicide, severe illness, or loss of a close family member, do NOT use the wake-up style.
In that case, write 3–5 respectful sentences, gentle tone, no urgency, no commands, no time framing, and NO $highlighting$.

Otherwise, YOU MUST maintain the bold wake-up style.
`;

    const user = `
timeLeft: ${timeLeft ? `"${timeLeft}"` : "null"}

What they're overthinking about:
"${text}"
`;

    const stream = await openai.responses.stream({
      model: "gpt-4.1",
      temperature: 0.9,
      input: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
    });

    let buffer = "";
    let i = 0;

const flushSentences = () => {
  while (true) {
    // Don't cut if we're inside an open $...$
    const dollarCount = (buffer.match(/\$/g) || []).length;
    const insideHighlight = dollarCount % 2 !== 0;
    if (insideHighlight) break;

    const match = buffer.match(/[.!?](\s+)|\n+/);
    if (!match || match.index == null) break;

    const end = match.index + match[0].length;
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end);

    const sentence = raw.replace(/\s+/g, " ").trim();
    if (!sentence) continue;

    i += 1;
    send({ type: "sentence", i, text: sentence });
  }
};

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        buffer += event.delta;
        flushSentences();
      }
    }

    const tail = buffer.replace(/\s+/g, " ").trim();
    if (tail) {
      i += 1;
      send({ type: "sentence", i, text: tail });
    }

    send({ type: "done" });
    res.end();
  } catch (e) {
    console.error(e);
    send({ type: "error", message: "Failed to generate message." });
    res.end();
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
