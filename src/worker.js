/**
 * Erlandi Temp Mail
 * Cloudflare Worker + D1 + Email Routing
 */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomToken(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
    .slice(0, len);
}

function randomLocal(prefix, len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) {
    s += chars[bytes[i] % chars.length];
  }
  return prefix + s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

/* ================= EMAIL HANDLER ================= */

async function handleEmail(message, env) {
  const to = message.to?.toLowerCase() || "";
  const domain = env.DOMAIN.toLowerCase();
  const prefix = env.INBOX_PREFIX.toLowerCase();

  if (!to.endsWith("@" + domain)) return;
  if (!to.startsWith(prefix)) return;

  const inbox = await env.DB.prepare(
    "SELECT id, expires_at FROM inboxes WHERE address = ?"
  ).bind(message.to).first();

  if (!inbox) return;
  if (inbox.expires_at <= nowSec()) return;

  const id = crypto.randomUUID();
  const received = nowSec();

  let textBody = "";
  try {
    textBody = await message.text();
  } catch {}

  await env.DB.prepare(`
    INSERT INTO messages (id, inbox_id, mail_from, rcpt_to, subject, received_at, text_body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    inbox.id,
    message.from || "",
    message.to || "",
    message.subject || "",
    received,
    textBody
  ).run();
}

/* ================= API HANDLER ================= */

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/api/inbox") {
    const token = randomToken();
    const address = randomLocal(env.INBOX_PREFIX) + "@" + env.DOMAIN;
    const created = nowSec();
    const expires = created + parseInt(env.TTL_SECONDS);

    await env.DB.prepare(`
      INSERT INTO inboxes (id, address, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(token, address, created, expires).run();

    return json({ token, address, expiresAt: expires });
  }

  const inboxMatch = path.match(/^\/api\/inbox\/(.+)\/messages$/);
  if (request.method === "GET" && inboxMatch) {
    const token = inboxMatch[1];

    const inbox = await env.DB.prepare(
      "SELECT id FROM inboxes WHERE id = ?"
    ).bind(token).first();

    if (!inbox) return json({ messages: [] });

    const rows = await env.DB.prepare(`
      SELECT id, mail_from as mailFrom, subject, received_at as receivedAt
      FROM messages
      WHERE inbox_id = ?
      ORDER BY received_at DESC
    `).bind(token).all();

    return json({ messages: rows.results });
  }

  const msgMatch = path.match(/^\/api\/message\/(.+)$/);
  if (request.method === "GET" && msgMatch) {
    const id = msgMatch[1];

    const row = await env.DB.prepare(`
      SELECT id, mail_from as mailFrom, rcpt_to as rcptTo,
             subject, received_at as receivedAt, text_body as textBody
      FROM messages WHERE id = ?
    `).bind(id).first();

    return json(row || {});
  }

  return json({ error: "Not found" }, 404);
}

/* ================= UI ================= */

function renderUi() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Erlandi Temp Mail</title>
<style>
body{
  margin:0;
  font-family:system-ui;
  background:#0f172a;
  color:#fff;
}
.container{max-width:900px;margin:auto;padding:20px;}
.card{background:#1e293b;padding:16px;border-radius:14px;margin-bottom:16px;}
button{padding:8px 14px;border-radius:10px;border:none;background:#3b82f6;color:#fff;cursor:pointer;}
input{width:100%;padding:8px;border-radius:10px;border:none;margin-top:6px;}
.list{margin-top:10px;}
.item{background:#334155;padding:10px;border-radius:10px;margin-bottom:6px;cursor:pointer;}
.item:hover{background:#475569;}
pre{white-space:pre-wrap;}
</style>
</head>
<body>
<div class="container">
<h2>📧 Erlandi Temp Mail</h2>

<div class="card">
<button id="newBtn">New Address</button>
<button id="refreshBtn" disabled>Refresh</button>
<div style="margin-top:10px">
<input id="address" readonly placeholder="Click New Address"/>
<div id="expires"></div>
</div>
</div>

<div class="card">
<h3>Inbox</h3>
<div id="list" class="list"></div>
</div>

<div class="card">
<h3>Message</h3>
<div id="meta"></div>
<pre id="viewer"></pre>
</div>
</div>

<script>
let token=null;

async function newInbox(){
  const r=await fetch('/api/inbox',{method:'POST'});
  const j=await r.json();
  token=j.token;
  address.value=j.address;
  expires.innerText="Expires: "+new Date(j.expiresAt*1000).toLocaleString();
  refreshBtn.disabled=false;
  refresh();
}

async function refresh(){
  if(!token)return;
  const r=await fetch('/api/inbox/'+token+'/messages');
  const j=await r.json();
  list.innerHTML="";
  (j.messages||[]).forEach(m=>{
    const div=document.createElement("div");
    div.className="item";
    div.innerHTML="<b>"+(m.subject||"(no subject)")+"</b><br>"+(m.mailFrom||"");
    div.onclick=()=>openMessage(m.id);
    list.appendChild(div);
  });
}

async function openMessage(id){
  const r=await fetch('/api/message/'+id);
  const j=await r.json();
  meta.innerHTML="From: "+(j.mailFrom||"");
  viewer.innerText=j.textBody||"";
}

newBtn.onclick=newInbox;
refreshBtn.onclick=refresh;
</script>
</body>
</html>`;
}

/* ================= EXPORT ================= */

export default {
  async email(message, env) {
    await handleEmail(message, env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return new Response(renderUi(), {
      headers: { "content-type": "text/html" }
    });
  }
};
