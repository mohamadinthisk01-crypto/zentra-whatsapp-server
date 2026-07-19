# Zentra WhatsApp Server

A real backend that connects to an actual WhatsApp account using **Baileys** (an unofficial
WhatsApp Web library), with AI auto-replies powered by Claude.

## Before you start — please read this

- This uses an **unofficial** library, not Meta's Business API. No business verification
  needed, and you can scan with any personal or business WhatsApp number.
- This is **against WhatsApp's Terms of Service**. There is a real risk of the number being
  banned, especially with high message volume or spam-like behavior. Safest use: one number,
  genuine 1:1 conversations, no bulk blasting.
- This server must **stay running continuously** to hold the WhatsApp connection open — on
  your own computer for testing, or a small always-on server (a $5/month VPS is enough) if
  you want it live full-time. It cannot run inside a Claude chat — Claude's sandbox has no
  network access to WhatsApp's servers and resets between sessions.

## Setup

1. **Install Node.js** (v18 or later) if you don't have it: https://nodejs.org

2. **Install dependencies:**
   ```bash
   cd whatsapp-server
   npm install
   ```

3. **Configure:**
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and fill in:
   - `ANTHROPIC_API_KEY` — get one at https://console.anthropic.com (without this, auto-replies fall back to a generic message instead of an AI-generated one)
   - `BIZ_NAME`, `BIZ_DESCRIPTION`, `BIZ_PRICING`, `BIZ_SCRIPT` — used so AI replies sound like your actual business

4. **Run it:**
   ```bash
   npm start
   ```
   You'll see `Zentra WhatsApp server listening on http://localhost:8787`.

5. **Get the QR code.** Either:
   - Open `http://localhost:8787/api/status` in a browser — it returns a `qr` field (a base64 image) once one is generated, usually within a few seconds, or
   - Point the Zentra app's WhatsApp page at this server (see below) and the QR will render there directly.

6. **Scan it** on the phone whose WhatsApp you want to connect: **WhatsApp → Settings → Linked Devices → Link a Device**.

7. Once connected, the terminal prints `WhatsApp connected as <your number>`. Your session is
   saved in `auth_info/` so you won't need to re-scan on restart (delete that folder to force
   a fresh login).

## Connecting the Zentra frontend

In the Zentra React app, the WhatsApp page needs to know where this server is running. By
default it looks for `http://localhost:8787`. If you run this server somewhere else (a VPS,
a different port), update the `WHATSAPP_BACKEND_URL` constant near the top of the
`WhatsAppWebPanel` component in `zentra-app.jsx`.

## API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | `{ status, qr, myNumber }` — status is `starting`, `qr`, `connected`, or `disconnected` |
| GET | `/api/chats` | List of chats with last message + whether an AI auto-reply is pending |
| GET | `/api/chats/:jid/messages` | Full message history for one chat |
| POST | `/api/chats/:jid/send` | Body `{ text }` — sends a real WhatsApp message and cancels any pending AI auto-reply |
| GET | `/api/chats/:jid/pending` | Whether the AI is about to auto-reply, and the configured window |
| POST | `/api/logout` | Unlinks the connected WhatsApp session |

## How the AI auto-reply works

Every incoming message starts a timer (`AUTOREPLY_MINUTES` in `.env`, default 1 minute). If
you reply from your own phone or through the app before the timer fires, it's cancelled. If
not, the server sends the full conversation history to Claude with a system prompt that asks
it to reply naturally, offer a relevant upsell once if it fits, and back off warmly (not
pushily) if the person seems uninterested — then sends that reply as a real WhatsApp message.

## Deploying so it runs 24/7

For production use, deploy `whatsapp-server/` to a small always-on host (a basic VPS on
Railway, Render, Fly.io, or a $5 DigitalOcean droplet all work fine — this app is lightweight).
Keep `auth_info/` persisted across deploys (it holds your login session) and never commit it
or `.env` to git — both are already in `.gitignore`.
