// Zentra WhatsApp Server
// Connects to a REAL WhatsApp account via Baileys (unofficial WhatsApp Web protocol library).
// Scan the QR with WhatsApp on your phone: Settings -> Linked Devices -> Link a Device.
//
// IMPORTANT: this uses an unofficial library, not Meta's official Business API.
// That means: no business verification needed, but it is against WhatsApp's Terms of
// Service to automate a number this way, and there is a real risk of the number being
// banned -- especially if used for bulk/marketing-style messages. Safest use: a single
// low-volume number, real 1:1 conversations, no spam-like blasting.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("baileys");

const PORT = process.env.PORT || 8787;
const AUTOREPLY_MINUTES = Number(process.env.AUTOREPLY_MINUTES || 1);
const AUTOREPLY_MS = AUTOREPLY_MINUTES * 60 * 1000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BIZ_NAME = process.env.BIZ_NAME || "the business";
const BIZ_DESCRIPTION = process.env.BIZ_DESCRIPTION || "";
const BIZ_PRICING = process.env.BIZ_PRICING || "";
const BIZ_SCRIPT = process.env.BIZ_SCRIPT || "";

const logger = pino({ level: process.env.LOG_LEVEL || "silent" });

// ── AI calling: Gemini (free tier) is used if GEMINI_API_KEY is set, since that
// costs nothing to run. Anthropic is used instead if ANTHROPIC_API_KEY is set and
// GEMINI_API_KEY isn't -- an easy upgrade path once you're ready to pay for Claude.
// Both paths return the SAME Anthropic-shaped response ({content:[{type,text}]}),
// so nothing in the frontend needs to change no matter which one is active.

async function callGemini(system, messages) {
  // Uses the official Google SDK rather than a raw REST call -- Google is
  // actively migrating API keys to a new format (old keys start "AIzaSy",
  // new ones start "AQ."), and the new format has been unreliable with
  // hand-rolled REST calls in real-world reports. The official SDK is
  // maintained by Google itself and handles this correctly either way.
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: contents,
    config: { systemInstruction: system },
  });
  const text = response.text || "";
  // Return in the same shape the frontend already expects from Anthropic
  return { content: [{ type: "text", text: text }] };
}

async function callClaude(system, messages, extra) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(Object.assign({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system,
      messages,
    }, extra || {})),
  });
  return res.json();
}

// Single entry point used everywhere in this file -- picks Gemini or Anthropic
// automatically based on which key is configured.
async function callAI(system, messages, extra) {
  if (GEMINI_API_KEY) return callGemini(system, messages);
  if (ANTHROPIC_API_KEY) return callClaude(system, messages, extra);
  throw new Error("No AI provider configured -- set GEMINI_API_KEY or ANTHROPIC_API_KEY");
}

// ── In-memory state (fine for one-person, one-number usage; swap for a DB if you scale) ──
let sock = null;
let state = {
  status: "starting", // starting | qr | connected | disconnected
  qrDataUrl: null,
  myNumber: null,
};
const chats = new Map(); // jid -> { jid, name, messages: [{id, from, text, ts}], unread }
const pendingTimers = new Map(); // jid -> Timeout handle

function getChat(jid, name) {
  if (!chats.has(jid)) {
    chats.set(jid, { jid, name: name || jid.split("@")[0], messages: [], unread: 0 });
  } else if (name) {
    chats.get(jid).name = name; // correct the name if a better one is now known
  }
  return chats.get(jid);
}

function cancelPending(jid) {
  const t = pendingTimers.get(jid);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(jid);
  }
}

function schedulePending(jid) {
  cancelPending(jid);
  const t = setTimeout(() => triggerAutoReply(jid), AUTOREPLY_MS);
  pendingTimers.set(jid, t);
}

async function triggerAutoReply(jid) {
  pendingTimers.delete(jid);
  const chat = chats.get(jid);
  if (!chat) return;

  const history = chat.messages.slice(-20).map((m) => ({
    role: m.from === "them" ? "user" : "assistant",
    content: m.text,
  }));
  const lastCustomerMsg = [...chat.messages].reverse().find((m) => m.from === "them");

  const system =
    `You are auto-replying on WhatsApp on behalf of ${BIZ_NAME}, stepping in only because ` +
    `no human on the team replied within ${AUTOREPLY_MINUTES} minute${AUTOREPLY_MINUTES === 1 ? "" : "s"}. ` +
    (BIZ_DESCRIPTION ? `Business: ${BIZ_DESCRIPTION}. ` : "") +
    (BIZ_PRICING ? `Pricing: ${BIZ_PRICING}. ` : "") +
    (BIZ_SCRIPT ? `Preferred sales approach: ${BIZ_SCRIPT}. ` : "") +
    `Read the full conversation and reply as a natural next message -- don't repeat questions ` +
    `already answered. If there's a natural upsell or next step, offer it once, warmly, without ` +
    `being pushy. If the conversation is winding down or they've said no / not now, close warmly ` +
    `and leave the door open -- never sound like you're nagging. Keep it short like a real ` +
    `WhatsApp message, 1-3 sentences, no markdown.`;

  let replyText = "Thanks for your patience! Someone from our team will follow up with you shortly.";

  if (GEMINI_API_KEY || ANTHROPIC_API_KEY) {
    try {
      const data = await callAI(system, history.length ? history : [{ role: "user", content: "Hello" }]);
      const out = (data.content || []).map((b) => b.text || "").join("\n").trim();
      if (out) replyText = out;
    } catch (err) {
      logger.error({ err }, "AI auto-reply generation failed, using fallback");
    }
  }

  await sendMessage(jid, replyText, "ai");
}

async function sendMessage(jid, text, from = "me") {
  if (!sock) throw new Error("WhatsApp not connected");
  await sock.sendMessage(jid, { text });
  const chat = getChat(jid);
  chat.messages.push({ id: Date.now(), from, text, ts: Date.now() });
  chat.unread = 0;
  cancelPending(jid); // a reply (human or AI) resets the clock
}

// ── Baileys connection lifecycle ──────────────────────────────────────────────
async function startSocket() {
  const { state: authState, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.qrDataUrl = await qrcode.toDataURL(qr);
      state.status = "qr";
      console.log("\nNew QR generated -- open the frontend or GET /api/status to see it.\n");
    }

    if (connection === "open") {
      state.status = "connected";
      state.qrDataUrl = null;
      state.myNumber = sock.user && sock.user.id ? sock.user.id.split(":")[0] : null;
      console.log("WhatsApp connected as", state.myNumber);
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect && lastDisconnect.error).output.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      state.status = "disconnected";
      state.qrDataUrl = null;
      console.log("Connection closed.", loggedOut ? "Logged out -- re-scan needed." : "Reconnecting...");
      if (!loggedOut) {
        startSocket();
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue; // skip groups/status
      const text =
        (msg.message &&
          (msg.message.conversation ||
            (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text))) ||
        null;
      if (!text) continue; // skip non-text (images/stickers/etc) for now

      // pushName on an outgoing (fromMe) message reflects YOUR OWN connected account's
      // name, not the other person's -- only trust it as a contact name when the message
      // is genuinely incoming from them.
      const name = !msg.key.fromMe ? (msg.pushName || null) : null;
      const chat = getChat(jid, name);

      if (msg.key.fromMe) {
        // You replied from your own phone -- cancel any pending AI auto-reply
        chat.messages.push({ id: Date.now(), from: "me", text, ts: Date.now() });
        cancelPending(jid);
      } else {
        chat.messages.push({ id: Date.now(), from: "them", text, ts: Date.now() });
        chat.unread += 1;
        schedulePending(jid);
      }
    }
  });
}

startSocket().catch((err) => {
  console.error("Failed to start WhatsApp socket:", err);
});

// ── REST API for the Zentra frontend ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({ status: state.status, qr: state.qrDataUrl, myNumber: state.myNumber });
});

app.get("/api/chats", (req, res) => {
  const list = Array.from(chats.values())
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      unread: c.unread,
      lastMessage: c.messages[c.messages.length - 1] || null,
      pending: pendingTimers.has(c.jid),
    }))
    .sort((a, b) => {
      const at = a.lastMessage ? a.lastMessage.ts : 0;
      const bt = b.lastMessage ? b.lastMessage.ts : 0;
      return bt - at;
    });
  res.json(list);
});

app.get("/api/chats/:jid/messages", (req, res) => {
  const chat = chats.get(req.params.jid);
  if (!chat) return res.json([]);
  chat.unread = 0;
  res.json(chat.messages);
});

app.post("/api/chats/:jid/send", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "text is required" });
    await sendMessage(req.params.jid, text.trim(), "me");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chats/:jid/pending", (req, res) => {
  const jid = req.params.jid;
  const pending = pendingTimers.has(jid);
  res.json({ pending, autoReplyMinutes: AUTOREPLY_MINUTES });
});

app.post("/api/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch (e) {
    // ignore -- socket may already be closed
  }
  res.json({ ok: true });
});

// Generic secure AI proxy for the main app (chat assistant, AI Mentor, voice replies).
// The frontend sends the same body it always has (model, max_tokens, system, messages) --
// this picks Gemini (free) or Anthropic (paid) automatically based on which key is set,
// and always returns the same Anthropic-shaped response either way, so the frontend
// doesn't need to know or care which provider actually answered.
// Note: if running on the free Gemini path, the AI Mentor's live web-search tool isn't
// available (that's an Anthropic-specific feature) -- it'll still answer normally from
// what it already knows, just without fetching fresh live data.
app.post("/api/ai-chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "No AI provider configured -- set GEMINI_API_KEY or ANTHROPIC_API_KEY on the server" });
    }
    const { system, messages, tools } = req.body;
    const data = await callAI(system, messages, tools ? { tools } : undefined);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Zentra WhatsApp server listening on http://localhost:${PORT}`);
  console.log(`Waiting for WhatsApp QR... check GET /api/status`);
});
