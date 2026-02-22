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

-No therapy tone.
-No clichés.
-No long paragraphs.
-No comfort language.
-No moral lectures.
-Use short punchy sentences.
-Maximum 6–8 sentences total.
-Each sentence must end with ".", "!" or "?".
-Insert 3–4 highlighted two-word or three-word phrases inside the message by wrapping them exactly like this: $three words$ or $two words$.
-The highlighted words must feel powerful and intentional, not random.
-The FINAL sentence MUST be fully wrapped with exclamation marks like this: $Your final sentence here.$
-The FINAL sentence must contain exactly ONE sentence only.
-Inside the final $...$ wrapping there must be only one ending punctuation mark (".", "!" or "?").
-The final $...$ sentence must not contain line breaks.
-There must not be multiple sentences inside the $...$ wrapping.
-Everything inside $...$ must be a single complete sentence.
-If the user text mentions death, suicide, severe illness, or losing a close family member (e.g., “my mom died”), you MUST NOT use the wake-up style.
In that case, write a short, respectful message (3–5 sentences), gentle tone, no urgency, no commands, no “time is limited” framing, and NO highlighted words using $...$.
-Otherwise, YOU MUST maintain the bold wake-up style.
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
