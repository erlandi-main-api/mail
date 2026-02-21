/**
 * Erlandi Temp Mail (compatible dengan schema yang punya message_key NOT NULL)
 * - Email Routing -> Email Worker -> D1
 * - HTTP API + UI
 */

function nowSec(){ return Math.floor(Date.now()/1000); }

function randomToken(len=24){
  const bytes=new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+","-").replaceAll("/","_").replaceAll("=","")
    .slice(0,len);
}

function randomLocalPart(prefix, n=8){
  const chars="abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes=new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s="";
  for(let i=0;i<n;i++) s+=chars[bytes[i]%chars.length];
  return `${prefix}${s}`;
}

function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store"
    }
  });
}

async function sha256Hex(str){
  const bytes=new TextEncoder().encode(str);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function cleanupExpired(env){
  const t=nowSec();
  await env.DB.prepare(`
    DELETE FROM messages
    WHERE inbox_id IN (SELECT id FROM inboxes WHERE expires_at <= ?)
  `).bind(t).run();
  await env.DB.prepare(`DELETE FROM inboxes WHERE expires_at <= ?`).bind(t).run();
}

async function readEmailBodies(message){
  let textBody=null, htmlBody=null;

  try { textBody = await message.text(); } catch {}
  // Ambil HTML dari raw (naive, tapi works untuk simple)
  try{
    const raw = await message.raw();
    const rawStr = new TextDecoder().decode(raw);
    const idx = rawStr.toLowerCase().indexOf("content-type: text/html");
    if(idx !== -1){
      const slice = rawStr.slice(idx);
      const bodyStart = slice.indexOf("\r\n\r\n");
      if(bodyStart !== -1) htmlBody = slice.slice(bodyStart+4).trim();
    }
  }catch{}

  if(textBody && textBody.length>200000) textBody=textBody.slice(0,200000);
  if(htmlBody && htmlBody.length>200000) htmlBody=htmlBody.slice(0,200000);
  return { textBody, htmlBody };
}

async function handleApi(request, env){
  const url=new URL(request.url);
  const path=url.pathname;

  await cleanupExpired(env);

  // POST /api/inbox
  if(request.method==="POST" && path==="/api/inbox"){
    const token=randomToken(24);
    const local=randomLocalPart(env.INBOX_PREFIX || "tmp-", 8);
    const address=`${local}@${env.DOMAIN}`;
    const created=nowSec();
    const ttl=parseInt(env.TTL_SECONDS || "3600", 10);
    const expires=created + (Number.isFinite(ttl)?ttl:3600);

    await env.DB.prepare(`
      INSERT INTO inboxes (id,address,created_at,expires_at)
      VALUES (?,?,?,?)
    `).bind(token,address,created,expires).run();

    return json({ token, address, expiresAt: expires });
  }

  // GET /api/inbox/:token/messages
  const m1 = path.match(/^\/api\/inbox\/([A-Za-z0-9\-_]{10,})\/messages$/);
  if(request.method==="GET" && m1){
    const token=m1[1];
    const inbox=await env.DB.prepare(
      `SELECT id,address,created_at,expires_at FROM inboxes WHERE id=?`
    ).bind(token).first();
    if(!inbox) return json({ error:"Inbox not found or expired" }, 404);

    const rows=await env.DB.prepare(`
      SELECT id, mail_from as mailFrom, subject, received_at as receivedAt
      FROM messages
      WHERE inbox_id=?
      ORDER BY received_at DESC
      LIMIT 50
    `).bind(token).all();

    return json({ inbox, messages: rows.results || [] });
  }

  // GET /api/message/:id
  const m2 = path.match(/^\/api\/message\/([A-Za-z0-9\-_:.]{10,})$/);
  if(request.method==="GET" && m2){
    const id=m2[1];
    const row=await env.DB.prepare(`
      SELECT id,
             inbox_id as inboxId,
             mail_from as mailFrom,
             rcpt_to as rcptTo,
             subject,
             received_at as receivedAt,
             text_body as textBody,
             html_body as htmlBody
      FROM messages
      WHERE id=?
    `).bind(id).first();
    if(!row) return json({ error:"Message not found" }, 404);
    return json(row);
  }

  return json({ error:"Not found" }, 404);
}

function renderUiHtml(){
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Erlandi Temp Mail</title>
<style>
body{font-family:system-ui;margin:20px;max-width:1000px}
.card{border:1px solid #ddd;border-radius:12px;padding:12px}
.row{display:flex;gap:16px;flex-wrap:wrap}
.left{flex:1;min-width:320px}
.right{flex:2;min-width:320px}
button{padding:10px 12px;border-radius:10px;border:1px solid #ccc;background:#fff;cursor:pointer}
input{padding:10px 12px;border-radius:10px;border:1px solid #ccc;width:100%}
ul{list-style:none;padding:0;margin:0}
li{padding:10px;border-bottom:1px solid #eee;cursor:pointer}
li:hover{background:#fafafa}
pre{white-space:pre-wrap;word-break:break-word}
iframe{width:100%;height:420px;border:1px solid #eee;border-radius:10px}
small{color:#666}
</style>
</head>
<body>
<h2>Erlandi Temp Mail</h2>

<div class="card">
  <button id="btnNew">New Address</button>
  <button id="btnRefresh" disabled>Refresh</button>
  <div style="margin-top:10px">
    <div><small>Address</small></div>
    <input id="addr" readonly placeholder="Click New Address"/>
    <div style="margin-top:6px"><small>Expires:</small> <span id="exp">-</span></div>
  </div>
</div>

<div class="row" style="margin-top:14px">
  <div class="card left">
    <b>Inbox</b>
    <ul id="list" style="margin-top:10px"></ul>
  </div>

  <div class="card right">
    <b>Message</b>
    <div id="meta" style="margin-top:10px"></div>
    <div style="margin-top:10px">
      <button id="viewText" disabled>Text</button>
      <button id="viewHtml" disabled>HTML</button>
    </div>
    <div id="viewer" style="margin-top:10px"></div>
  </div>
</div>

<script>
let token=null, currentMsg=null;

const addrEl=document.getElementById('addr');
const expEl=document.getElementById('exp');
const listEl=document.getElementById('list');
const metaEl=document.getElementById('meta');
const viewer=document.getElementById('viewer');
const btnRefresh=document.getElementById('btnRefresh');
const btnNew=document.getElementById('btnNew');
const viewText=document.getElementById('viewText');
const viewHtml=document.getElementById('viewHtml');

function fmtTime(sec){ return new Date(sec*1000).toLocaleString(); }
function esc(s){ return (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

async function newInbox(){
  const r=await fetch('/api/inbox',{method:'POST'});
  const j=await r.json();
  token=j.token;
  addrEl.value=j.address;
  expEl.textContent=fmtTime(j.expiresAt);
  btnRefresh.disabled=false;
  refresh();
}

async function refresh(){
  if(!token) return;
  const r=await fetch('/api/inbox/'+token+'/messages');
  const j=await r.json();
  if(j.error){ listEl.innerHTML='<li><small>'+esc(j.error)+'</small></li>'; return; }
  listEl.innerHTML='';
  const msgs=j.messages||[];
  if(msgs.length===0){ listEl.innerHTML='<li><small>No messages yet</small></li>'; return; }
  msgs.forEach(m=>{
    const li=document.createElement('li');
    li.innerHTML='<div><b>'+esc(m.subject||'(no subject)')+'</b></div><div><small>'+esc(m.mailFrom||'')+' • '+fmtTime(m.receivedAt)+'</small></div>';
    li.onclick=()=>openMessage(m.id);
    listEl.appendChild(li);
  });
}

async function openMessage(id){
  const r=await fetch('/api/message/'+id);
  const j=await r.json();
  currentMsg=j;
  metaEl.innerHTML=
    '<div><small>From:</small> '+esc(j.mailFrom||'-')+'</div>'+
    '<div><small>To:</small> '+esc(j.rcptTo||'-')+'</div>'+
    '<div><small>Subject:</small> '+esc(j.subject||'-')+'</div>'+
    '<div><small>Received:</small> '+fmtTime(j.receivedAt)+'</div>';
  viewText.disabled=false; viewHtml.disabled=false;
  showText();
}

function showText(){
  viewer.innerHTML='<pre>'+esc(currentMsg?.textBody||'(no text)')+'</pre>';
}
function showHtml(){
  const html=currentMsg?.htmlBody || '<pre>(no html)</pre>';
  const iframe=document.createElement('iframe');
  iframe.setAttribute('sandbox','allow-same-origin');
  viewer.innerHTML='';
  viewer.appendChild(iframe);
  iframe.srcdoc=html;
}

btnNew.onclick=newInbox;
btnRefresh.onclick=refresh;
viewText.onclick=showText;
viewHtml.onclick=showHtml;
</script>
</body></html>`;
}

export default {
  async email(message, env, ctx){
    const to=(message.to||"").toLowerCase();
    const prefix=(env.INBOX_PREFIX||"tmp-").toLowerCase();
    const domain=(env.DOMAIN||"").toLowerCase();

    // hanya terima tmp-*@erlandi.my.id
    if(!to.endsWith("@"+domain) || !to.startsWith(prefix)) return;

    const inbox = await env.DB.prepare(
      `SELECT id, expires_at FROM inboxes WHERE address=?`
    ).bind(message.to).first();

    if(!inbox) return;
    if(inbox.expires_at <= nowSec()) return;

    // message_key wajib agar sesuai schema NOT NULL + anti dobel
    const hdrId = message.headers?.get?.("Message-ID") || "";
    const keyBase = `${hdrId}|${message.from}|${message.to}|${message.subject||""}`;
    const messageKey = await sha256Hex(keyBase);

    const id = crypto.randomUUID();
    const received = nowSec();
    const { textBody, htmlBody } = await readEmailBodies(message);

    try{
      await env.DB.prepare(`
        INSERT INTO messages
          (id, inbox_id, message_key, mail_from, rcpt_to, subject, received_at, text_body, html_body)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, inbox.id, messageKey,
        message.from || null,
        message.to || null,
        message.subject || null,
        received,
        textBody,
        htmlBody
      ).run();
    }catch(e){
      // duplicate message_key atau error lain -> biarkan
    }
  },

  async fetch(request, env, ctx){
    const url=new URL(request.url);

    if(url.pathname.startsWith("/api/")){
      return handleApi(request, env);
    }

    if(url.pathname==="/"){
      return new Response(renderUiHtml(), { headers: { "content-type":"text/html; charset=utf-8" }});
    }

    return new Response("Not found", { status:404 });
  }
};
