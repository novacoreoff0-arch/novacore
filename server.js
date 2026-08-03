// NovaCore backend — serves the site AND proxies Nova AI chat requests to the
// real Anthropic API using YOUR OWN API key (kept server-side, never sent to
// the browser). This is what actually makes Nova smart — the old in-browser
// fetch() could never work outside Claude.ai's own preview, no matter how the
// prompt was worded, because there's no API key available in a plain static
// site. Requires Node.js 18+ (for built-in fetch).

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' })); // generous limit since chat history can include long messages

// Serve index.html / styles.css / app.js from the parent folder, so the whole
// site works from this one server — just visit http://localhost:3001
app.use(express.static(path.join(__dirname, '..')));

/* ============================================================
   SHARED STATE — users + posts, persisted to a JSON file on this
   server so every visitor sees the same directory and feed, instead
   of each browser only ever seeing its own localStorage copy. This
   is what makes "who's online" and "who posted what" actually mean
   something across different people/devices.
============================================================ */
const DATA_FILE = path.join(__dirname, 'data.json');
const ONLINE_WINDOW_MS = 30 * 1000; // a user counts as online if we heard from them in the last 30s

function loadDB(){
  try{
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { users: parsed.users || {}, posts: parsed.posts || [], shareNotices: parsed.shareNotices || [], postReports: parsed.postReports || [] };
  }catch(e){
    return { users: {}, posts: [], shareNotices: [], postReports: [] };
  }
}

let db = loadDB();
let saveTimer = null;
function saveDB(){
  // debounce writes so a burst of requests (likes, heartbeats) doesn't hammer the disk
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => {
      if(err) console.error('Failed to save data.json:', err);
    });
  }, 250);
}

function publicUsers(){
  const now = Date.now();
  return Object.values(db.users).map(u => ({ ...u, isOnline: (now - (u.lastSeen || 0)) < ONLINE_WINDOW_MS }));
}

// GET the full shared directory + feed. The frontend polls this while the app is open so
// everyone's browser converges on the same picture of who's online and what's been posted.
app.get('/api/state', (req, res) => {
  res.json({ users: publicUsers(), posts: db.posts, shareNotices: db.shareNotices, postReports: db.postReports });
});

// Called on sign-in and then every ~12s while signed in, so "online now" reflects reality
// instead of just whatever this one browser happened to see.
app.post('/api/heartbeat', (req, res) => {
  const { email } = req.body || {};
  if(!email) return res.status(400).json({ error: 'Request body must include "email".' });
  const key = email.toLowerCase();
  db.users[key] = { ...(db.users[key] || {}), ...req.body, email, lastSeen: Date.now() };
  saveDB();
  res.json({ ok: true });
});

// Called on sign-out so the person disappears from "online now" immediately, rather than
// waiting out the heartbeat window.
app.post('/api/signout', (req, res) => {
  const { email } = req.body || {};
  if(!email) return res.status(400).json({ error: 'Request body must include "email".' });
  const key = email.toLowerCase();
  if(db.users[key]){ db.users[key].lastSeen = 0; saveDB(); }
  res.json({ ok: true });
});

// Upserts a full user record — used for moderation actions (warn/suspend/ban/verify) and
// follow/unfollow, which change fields beyond what a heartbeat carries.
app.post('/api/users/upsert', (req, res) => {
  const { email } = req.body || {};
  if(!email) return res.status(400).json({ error: 'Request body must include "email".' });
  const key = email.toLowerCase();
  const existingLastSeen = db.users[key] ? db.users[key].lastSeen : 0;
  db.users[key] = { ...(db.users[key] || {}), ...req.body, email, lastSeen: req.body.lastSeen || existingLastSeen };
  saveDB();
  res.json({ ok: true });
});

// Upserts a full post — used for new posts, likes, comments, and shares. The whole object
// is sent each time (small, and simplest to keep consistent with the moderation upsert above).
app.post('/api/posts/upsert', (req, res) => {
  const post = req.body;
  if(!post || !post.id) return res.status(400).json({ error: 'Request body must include an "id".' });
  const idx = db.posts.findIndex(p => p.id === post.id);
  if(idx >= 0) db.posts[idx] = post; else db.posts.unshift(post);
  saveDB();
  res.json({ ok: true });
});

// A share doesn't send a chat message — it just logs a notice for the original author's
// Inbox. Kept server-side too, so it shows up no matter which device the author is on.
app.post('/api/share-notices', (req, res) => {
  const notice = req.body;
  if(!notice || !notice.forEmail) return res.status(400).json({ error: 'Request body must include "forEmail".' });
  db.shareNotices.push(notice);
  saveDB();
  res.json({ ok: true });
});

// Removes a post entirely — used both when someone deletes their own post, and when a
// developer removes a reported one.
app.post('/api/posts/delete', (req, res) => {
  const { id } = req.body || {};
  if(id === undefined) return res.status(400).json({ error: 'Request body must include "id".' });
  db.posts = db.posts.filter(p => p.id !== id);
  saveDB();
  res.json({ ok: true });
});

// Upserts a post report so every developer session sees the same moderation queue,
// regardless of which device reported or which device is reviewing.
app.post('/api/reports/upsert', (req, res) => {
  const report = req.body;
  if(!report || !report.id) return res.status(400).json({ error: 'Request body must include an "id".' });
  const idx = db.postReports.findIndex(r => r.id === report.id);
  if(idx >= 0) db.postReports[idx] = report; else db.postReports.push(report);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!groqKey && !anthropicKey) {
    return res.status(500).json({
      error: 'No AI key set. Add GROQ_API_KEY (free, console.groq.com) or ANTHROPIC_API_KEY to .env.'
    });
  }

  const { messages, system } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request body must include a "messages" array.' });
  }

  // Prefer Groq when a key is present — it's free and fast. Its API is OpenAI-compatible,
  // so we translate the request/response shape to match what the frontend already expects
  // from Anthropic's format (data.content -> array of {type:'text', text}).
  if (groqKey) {
    try {
      const groqMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          max_tokens: 1000,
          messages: groqMessages
        })
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('Groq API error:', data);
        return res.status(response.status).json(data);
      }
      const text = data.choices?.[0]?.message?.content || '';
      return res.json({ content: [{ type: 'text', text }] });
    } catch (err) {
      console.error('Server error reaching Groq:', err);
      return res.status(502).json({ error: 'Could not reach the Groq API from the server.' });
    }
  }

  // Fallback — Anthropic, if no Groq key is set
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: system || undefined,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('Server error reaching Anthropic:', err);
    res.status(502).json({ error: 'Could not reach the Anthropic API from the server.' });
  }
});

const PORT = process.env.PORT || 3001;

// Real email sending, using Resend (https://resend.com) — a transactional email API with
// a generous free tier and no SMTP setup. This is what actually lets NovaCore deliver a
// verification code to a real inbox instead of just showing it on screen. Just like the
// Anthropic key above, this API key stays server-side and is never sent to the browser.
// Shared by /api/send-email and /api/request-otp below — returns true/false rather than
// throwing, since callers need to keep working (with an on-screen fallback) even when
// Resend isn't configured or the request fails.
async function sendEmailViaResend(to, subject, text){
  const apiKey = process.env.RESEND_API_KEY;
  if(!apiKey) return false;
  try{
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'NovaCore <onboarding@resend.dev>',
        to: [to], subject, text
      })
    });
    if(!response.ok){
      const data = await response.json().catch(()=>({}));
      console.error('Resend API error:', data);
      return false;
    }
    return true;
  }catch(err){
    console.error('Server error reaching Resend:', err);
    return false;
  }
}

app.post('/api/send-email', async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Missing RESEND_API_KEY. Sign up free at resend.com, verify a sending domain (or use their onboarding@resend.dev test address), and add the key to .env.'
    });
  }

  const { to, subject, text } = req.body || {};
  if (!to || !subject || !text) {
    return res.status(400).json({ error: 'Request body must include "to", "subject", and "text".' });
  }

  const sent = await sendEmailViaResend(to, subject, text);
  if(!sent) return res.status(502).json({ error: 'Could not send the email via Resend.' });
  res.json({ ok: true });
});

/* ============================================================
   REAL ONE-TIME PASSWORDS (OTP) — the code is generated and checked
   here on the server, not in the browser. The frontend never sees
   the code at all when email sending actually works; it only falls
   back to showing the code on-screen when there's no way to email
   it (no RESEND_API_KEY configured), so the demo still works.
============================================================ */
const otpStore = {};       // { [email]: { code, expires, attempts } } — swap for a real DB in production
const otpRequestLog = {};  // { [email]: [timestamps] } — basic per-email rate limiting
const OTP_EXPIRY_MS = 5 * 60 * 1000;            // codes are only good for 5 minutes
const OTP_MAX_ATTEMPTS = 5;                      // wrong guesses allowed before the code is burned
const OTP_MAX_REQUESTS_PER_WINDOW = 5;           // new codes allowed per email...
const OTP_REQUEST_WINDOW_MS = 10 * 60 * 1000;    // ...per this many minutes

function generateOTP(){
  return crypto.randomInt(100000, 999999).toString(); // crypto-secure, unlike Math.random()
}

app.post('/api/request-otp', async (req, res) => {
  const { email, subject } = req.body || {};
  if(!email) return res.status(400).json({ error: 'Request body must include "email".' });
  const key = email.toLowerCase();
  const now = Date.now();

  otpRequestLog[key] = (otpRequestLog[key] || []).filter(t => now - t < OTP_REQUEST_WINDOW_MS);
  if(otpRequestLog[key].length >= OTP_MAX_REQUESTS_PER_WINDOW){
    return res.status(429).json({ error: 'Too many codes requested for this email — wait a bit and try again.' });
  }
  otpRequestLog[key].push(now);

  const code = generateOTP();
  otpStore[key] = { code, expires: now + OTP_EXPIRY_MS, attempts: 0 };

  const emailed = await sendEmailViaResend(
    email,
    subject || 'Your NovaCore verification code',
    `Your NovaCore verification code is: ${code}\n\nThis code expires in 5 minutes.`
  );

  // Only hand the code back to the browser when it truly couldn't be emailed — with
  // Resend configured, this branch never fires and the code stays server-side only.
  res.json({ ok: true, emailed, devCode: emailed ? undefined : code });
});

app.post('/api/verify-otp', (req, res) => {
  const { email, code } = req.body || {};
  if(!email || !code) return res.status(400).json({ error: 'Request body must include "email" and "code".' });
  const key = email.toLowerCase();
  const entry = otpStore[key];

  if(!entry) return res.status(400).json({ ok:false, error: 'No code was requested for this email — request a new one.' });
  if(Date.now() > entry.expires){ delete otpStore[key]; return res.status(400).json({ ok:false, error: 'That code expired — request a new one.' }); }

  entry.attempts++;
  if(entry.attempts > OTP_MAX_ATTEMPTS){ delete otpStore[key]; return res.status(429).json({ ok:false, error: 'Too many incorrect attempts — request a new code.' }); }

  if(entry.code !== String(code).trim()){
    return res.status(400).json({ ok:false, error: 'Incorrect code.' });
  }
  delete otpStore[key]; // one-time use — can't be replayed
  res.json({ ok: true });
});

// Real SMS sending, using Twilio (https://twilio.com) — unlike email, this is NOT free
// (roughly $0.0079/text in the US, plus a small monthly fee to rent the sending number).
// The Account SID and Auth Token stay server-side, same reasoning as the keys above.
app.post('/api/send-sms', async (req, res) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !fromNumber) {
    return res.status(500).json({
      error: 'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER. Sign up at twilio.com, buy a number, and add all three to .env.'
    });
  }

  const { to, body } = req.body || {};
  if (!to || !body) {
    return res.status(400).json({ error: 'Request body must include "to" and "body".' });
  }

  try {
    const params = new URLSearchParams({ To: to, From: fromNumber, Body: body });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
      },
      body: params
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Twilio API error:', data);
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('Server error reaching Twilio:', err);
    res.status(502).json({ error: 'Could not reach Twilio from the server.' });
  }
});

app.listen(PORT, () => {
  console.log(`NovaCore is running at http://localhost:${PORT}`);
  if (!process.env.GROQ_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  No GROQ_API_KEY or ANTHROPIC_API_KEY set — Nova AI will fall back to its basic local replies. See .env.example.');
  } else if (process.env.GROQ_API_KEY) {
    console.log('✓ Nova AI is using Groq (free tier).');
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  No RESEND_API_KEY set — verification codes will only show on screen, not send to a real inbox. See .env.example.');
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
    console.warn('⚠️  Twilio not fully configured — phone verification codes will only show on screen, not send as a real text. See .env.example.');
  }
});
