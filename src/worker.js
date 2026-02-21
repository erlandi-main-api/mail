/**
 * Erlandi Temp Mail
 * Cloudflare Worker (Email + HTTP) + D1
 * Compatible with schema.sql (message_key NOT NULL, html_body available)
 */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomToken(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
    .slice(0, len);
}

function randomLocalPart(prefix, n = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return `${prefix}${s}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function cleanupExpired(env) {
  const t = nowSec();
  await env.DB.prepare(`
    DELETE FROM messages
    WHERE inbox_id IN (SELECT id FROM inboxes WHERE expires_at <= ?)
  `).bind(t).run();

  await env.DB.prepare(`DELETE FROM inboxes WHERE expires_at <= ?`)
    .bind(t)
    .run();
}

async function readEmailBodies(message) {
  let textBody = null;
  let htmlBody = null;

  // text()
  try {
    textBody = await message.text();
  } catch {}

  // naive HTML capture from raw()
  try {
    const raw = await message.raw();
    const rawStr = new TextDecoder().decode(raw);
    const idx = rawStr.toLowerCase().indexOf("content-type: text/html");
    if (idx !== -1) {
      const slice = rawStr.slice(idx);
      const bodyStart = slice.indexOf("\r\n\r\n");
      if (bodyStart !== -1) htmlBody = slice.slice(bodyStart + 4).trim();
    }
  } catch {}

  if (textBody && textBody.length > 200000) textBody = textBody.slice(0, 200000);
  if (htmlBody && htmlBody.length > 200000) htmlBody = htmlBody.slice(0, 200000);

  return { textBody, htmlBody };
}

/* ================= API ================= */

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  await cleanupExpired(env);

  // POST /api/inbox -> create new inbox address
  if (request.method === "POST" && path === "/api/inbox") {
    const token = randomToken(24);
    const local = randomLocalPart(env.INBOX_PREFIX || "tmp-", 8);
    const address = `${local}@${env.DOMAIN}`;
    const created = nowSec();
    const ttl = parseInt(env.TTL_SECONDS || "3600", 10);
    const expires = created + (Number.isFinite(ttl) ? ttl : 3600);

    await env.DB.prepare(`
      INSERT INTO inboxes (id, address, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(token, address, created, expires).run();

    return json({ token, address, expiresAt: expires });
  }

  // GET /api/inbox/:token/messages
  const m1 = path.match(/^\/api\/inbox\/([A-Za-z0-9\-_]{10,})\/messages$/);
  if (request.method === "GET" && m1) {
    const token = m1[1];

    const inbox = await env.DB.prepare(
      `SELECT id, address, created_at, expires_at FROM inboxes WHERE id = ?`
    ).bind(token).first();

    if (!inbox) return json({ error: "Inbox not found or expired" }, 404);

    const rows = await env.DB.prepare(`
      SELECT id, mail_from as mailFrom, subject, received_at as receivedAt
      FROM messages
      WHERE inbox_id = ?
      ORDER BY received_at DESC
      LIMIT 50
    `).bind(token).all();

    return json({ inbox, messages: rows.results || [] });
  }

  // GET /api/message/:id
  const m2 = path.match(/^\/api\/message\/([A-Za-z0-9\-_:.]{10,})$/);
  if (request.method === "GET" && m2) {
    const id = m2[1];

    const row = await env.DB.prepare(`
      SELECT id,
             inbox_id as inboxId,
             mail_from as mailFrom,
             rcpt_to as rcptTo,
             subject,
             received_at as receivedAt,
             text_body as textBody,
             html_body as htmlBody
      FROM messages
      WHERE id = ?
    `).bind(id).first();

    if (!row) return json({ error: "Message not found" }, 404);
    return json(row);
  }

  return json({ error: "Not found" }, 404);
}

/* ================= UI ================= */

function renderUiHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Erlandi Temp Mail</title>
<style>
  body{margin:0;font-family:system-ui;background:#0f172a;color:#fff}
  .wrap{max-width:980px;margin:0 auto;padding:18px}
  .card{background:#1e293b;border-radius:14px;padding:14px;margin-bottom:14px}
  button{padding:10px 12px;border-radius:10px;border:0;background:#3b82f6;color:#fff;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  input{width:100%;padding:10px 12px;border-radius:10px;border:0;margin-top:8px}
  .grid{display:grid;grid-template-columns:1fr 1.2fr;gap:14px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .item{background:#334155;border-radius:12px;padding:10px;margin-bottom:8px;cursor:pointer}
  .item:hover{background:#475569}
  pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;border-radius:12px;padding:12px}
  .meta{color:#cbd5e1;font-size:14px;line-height:1.4}
  .row{display:flex;gap:10px;flex-wrap:wrap}
</style>
</head>
<body>
<div class="wrap">
  <h2 style="margin:0 0 12px">📧 Erlandi Temp Mail</h2>

  <div class="card">
    <div class="row">
      <button id="btnNew">New Address</button>
      <button id="btnRefresh" disabled>Refresh</button>
    </div>
    <div style="margin-top:10px">
      <div style="opacity:.8;font-size:13px">Address</div>
      <input id="addr" readonly placeholder="Click New Address"/>
      <div style="opacity:.8;font-size:13px;margin-top:8px">Expires: <span id="exp">-</span></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3 style="margin:0 0 10px">Inbox</h3>
      <div id="list"></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px">Message</h3>
      <div id="meta" class="meta">Select message…</div>
      <div class="row" style="margin-top:10px">
        <button id="btnText" disabled>Text</button>
        <button id="btnHtml" disabled>HTML</button>
      </div>
      <div id="viewer" style="margin-top:10px"></div>
    </div>
  </div>
</div>

<script>
let token = null;
let currentMsg = null;

const addr = document.getElementById('addr');
const exp  = document.getElementById('exp');
const list = document.getElementById('list');
const meta = document.getElementById('meta');
const viewer = document.getElementById('viewer');

const btnNew = document.getElementById('btnNew');
const btnRefresh = document.getElementById('btnRefresh');
const btnText = document.getElementById('btnText');
const btnHtml = document.getElementById('btnHtml');

function esc(s){ return (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function fmt(sec){ return new Date(sec*1000).toLocaleString(); }

async function newInbox(){
  const r = await fetch('/api/inbox', { method:'POST' });
  const j = await r.json();
  if(!r.ok){ alert(j.error || 'Failed'); return; }
  token = j.token;
  addr.value = j.address;
  exp.textContent = fmt(j.expiresAt);
  btnRefresh.disabled = false;
  await refresh();
}

async function refresh(){
  if(!token) return;
  const r = await fetch('/api/inbox/' + token + '/messages');
  const j = await r.json();
  if(!r.ok){ list.innerHTML = '<div class="item">'+esc(j.error||'Error')+'</div>'; return; }

  const msgs = j.messages || [];
  list.innerHTML = '';
  if(msgs.length === 0){
    list.innerHTML = '<div class="item">No messages yet</div>';
    return;
  }
  msgs.forEach(m=>{
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = '<b>' + esc(m.subject || '(no subject)') + '</b><br><span style="opacity:.85">' + esc(m.mailFrom || '') + ' • ' + fmt(m.receivedAt) + '</span>';
    div.onclick = () => openMsg(m.id);
    list.appendChild(div);
  });
}

async function openMsg(id){
  const r = await fetch('/api/message/' + id);
  const j = await r.json();
  if(!r.ok){ alert(j.error || 'Error'); return; }

  currentMsg = j;
  meta.innerHTML =
    '<div><b>From:</b> ' + esc(j.mailFrom || '-') + '</div>' +
    '<div><b>To:</b> ' + esc(j.rcptTo || '-') + '</div>' +
    '<div><b>Subject:</b> ' + esc(j.subject || '-') + '</div>' +
    '<div><b>Received:</b> ' + fmt(j.receivedAt) + '</div>';

  btnText.disabled = false;
  btnHtml.disabled = false;
  showText();
}

function showText(){
  viewer.innerHTML = '<pre>' + esc(currentMsg?.textBody || '(no text)') + '</pre>';
}

function showHtml(){
  const html = currentMsg?.htmlBody;
  if(!html){ viewer.innerHTML = '<pre>(no html)</pre>'; return; }
  const iframe = document.createElement('iframe');
  iframe.style.width = '100%';
  iframe.style.height = '420px';
  iframe.style.border = '0';
  iframe.style.borderRadius = '12px';
  viewer.innerHTML = '';
  viewer.appendChild(iframe);
  iframe.srcdoc = html;
}

btnNew.onclick = newInbox;
btnRefresh.onclick = refresh;
btnText.onclick = showText;
btnHtml.onclick = showHtml;
</script>
</body>
</html>`;
}

/* ================= EMAIL EVENT ================= */

export default {
  async email(message, env, ctx) {
    const to = (message.to || "").toLowerCase();
    const prefix = (env.INBOX_PREFIX || "tmp-").toLowerCase();
    const domain = (env.DOMAIN || "").toLowerCase();

    // only accept tmp-*@erlandi.my.id
    if (!to.endsWith("@" + domain) || !to.startsWith(prefix)) return;

    const inbox = await env.DB.prepare(
      `SELECT id, expires_at FROM inboxes WHERE address = ?`
    ).bind(message.to).first();

    if (!inbox) return;
    if (inbox.expires_at <= nowSec()) return;

    // message_key required by schema.sql (NOT NULL + unique)
    const hdrId = message.headers?.get?.("Message-ID") || "";
    const keyBase = \`\${hdrId}|\${message.from}|\${message.to}|\${message.subject||""}\`;
    const messageKey = await sha256Hex(keyBase);

    const id = crypto.randomUUID();
    const received = nowSec();
    const { textBody, htmlBody } = await readEmailBodies(message);

    try {
      await env.DB.prepare(`
        INSERT INTO messages
          (id, inbox_id, message_key, mail_from, rcpt_to, subject, received_at, text_body, html_body)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        inbox.id,
        messageKey,
        message.from || null,
        message.to || null,
        message.subject || null,
        received,
        textBody,
        htmlBody
      ).run();
    } catch (e) {
      // duplicate message_key or other insert errors -> ignore
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname === "/") {
      return new Response(renderUiHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
