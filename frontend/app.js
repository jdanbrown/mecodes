// --- State ---
let sessions = [];
let currentId = null;
const messages = {}; // sessionId -> [{id, role, parts}]
const streaming = {}; // sessionId -> {msgId -> accumulated text}
const generating = {}; // sessionId -> bool
let sse = null;

// --- API ---
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${r.status}: ${txt}`);
  }
  if (r.status === 204 || r.headers.get("content-length") === "0") return null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return r.json();
  return null;
}
const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b);
const del = (p) => api("DELETE", p);

// --- Health ---
async function checkHealth() {
  for (const [url, dot] of [
    ["/health", "dotOc"],
    ["/admin/health", "dotSc"],
  ]) {
    try {
      await get(url);
      document.getElementById(dot).className = "dot ok";
    } catch {
      document.getElementById(dot).className = "dot err";
    }
  }
}

// --- Sessions ---
async function loadSessions() {
  try {
    const data = await get("/session");
    // opencode may return array directly or {sessions:[...]}
    sessions = Array.isArray(data) ? data : (data?.sessions ?? []);
    renderSessionList();
  } catch (e) {
    console.error("loadSessions:", e);
    setSessionListHTML('<div class="session-empty">Failed to load sessions</div>');
  }
}

async function createSession() {
  const dir = document.getElementById("dirInput").value.trim() || undefined;
  document.getElementById("createBtn").disabled = true;
  try {
    const s = await post("/session", dir ? { directory: dir } : {});
    // Avoid duplicates if SSE already added it
    if (!sessions.find((x) => x.id === s.id)) sessions.unshift(s);
    renderSessionList();
    await selectSession(s.id);
    closeNewForm();
  } catch (e) {
    alert(`Failed to create session: ${e.message}`);
  } finally {
    document.getElementById("createBtn").disabled = false;
  }
}

async function deleteSession(id, ev) {
  ev.stopPropagation();
  if (!confirm("Delete this session?")) return;
  try {
    await del(`/session/${id}`);
  } catch (e) {
    // 404 is fine — already gone
    if (!e.message.startsWith("404")) {
      alert(`Failed: ${e.message}`);
      return;
    }
  }
  sessions = sessions.filter((s) => s.id !== id);
  delete messages[id];
  delete streaming[id];
  if (currentId === id) {
    currentId = null;
    renderMain();
  }
  renderSessionList();
}

async function selectSession(id) {
  currentId = id;
  renderSessionList();
  renderMain();
  closeSidebar();
  if (!messages[id]) await fetchMessages(id);
  renderMessages();
}

async function fetchMessages(id) {
  try {
    const data = await get(`/session/${id}`);
    // opencode returns session object; messages are in data.messages or nested
    const msgs = data?.messages ?? data?.chat?.messages ?? [];
    messages[id] = msgs;
  } catch (e) {
    console.error("fetchMessages:", e);
    messages[id] = [];
  }
}

async function sendPrompt() {
  const ta = document.getElementById("prompt");
  const text = ta.value.trim();
  if (!text || !currentId) return;

  ta.value = "";
  autoResize(ta);
  setSending(true);

  // Optimistic user message
  if (!messages[currentId]) messages[currentId] = [];
  messages[currentId].push({ id: `opt-${Date.now()}`, role: "user", parts: [{ type: "text", text }] });
  renderMessages();

  try {
    await post(`/session/${currentId}/prompt_async`, {
      content: [{ type: "text", text }],
    });
    generating[currentId] = true;
    renderAbortBtn();
  } catch (e) {
    setSending(false);
    alert(`Send failed: ${e.message}`);
  }
}

async function abortSession() {
  if (!currentId) return;
  try {
    await post(`/session/${currentId}/abort`);
  } catch (e) {
    console.warn("abort:", e);
  }
  generating[currentId] = false;
  setSending(false);
  renderAbortBtn();
}

// --- SSE ---
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource("/event");

  sse.onopen = () => {
    const el = document.getElementById("sseStatus");
    el.textContent = "● live";
    el.style.color = "var(--green)";
  };
  sse.onerror = () => {
    const el = document.getElementById("sseStatus");
    el.textContent = "○ reconnecting";
    el.style.color = "var(--orange)";
  };
  sse.onmessage = (ev) => handleEvent(ev.data);

  // Named event types opencode may emit
  for (const t of [
    "message",
    "session",
    "session.created",
    "session.updated",
    "message.created",
    "message.updated",
    "message.part",
    "assistant.streaming",
    "assistant.done",
  ]) {
    sse.addEventListener(t, (ev) => handleEvent(ev.data));
  }
}

function handleEvent(raw) {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  if (!ev) return;

  const type = ev.type ?? ev.event ?? "";
  const sid = ev.sessionId ?? ev.session_id ?? ev.session?.id ?? null;

  // Session list updates
  if (type.includes("session") && ev.session) {
    const idx = sessions.findIndex((s) => s.id === ev.session.id);
    if (idx >= 0) sessions[idx] = ev.session;
    else if (type.includes("created")) sessions.unshift(ev.session);
    renderSessionList();
    if (ev.session.id === currentId) renderChatTitle();
  }

  // Message upsert
  if (ev.message && sid) {
    if (!messages[sid]) messages[sid] = [];
    const list = messages[sid];
    const idx = list.findIndex((m) => m.id === ev.message.id);
    if (idx >= 0) list[idx] = ev.message;
    else list.push(ev.message);
    // Clear streaming for this message once it's committed
    if (streaming[sid]?.[ev.message.id]) delete streaming[sid][ev.message.id];
    if (sid === currentId) renderMessages();
  }

  // Streaming text parts
  if (type === "message.part" && sid && ev.part) {
    const msgId = ev.messageId ?? ev.message_id ?? "_stream";
    if (!streaming[sid]) streaming[sid] = {};
    if (ev.part.type === "text") {
      streaming[sid][msgId] = (streaming[sid][msgId] ?? "") + (ev.part.text ?? "");
    }
    if (sid === currentId) renderMessages();
  }

  // Done signal
  if (type === "assistant.done" || (type === "message.updated" && ev.message?.status === "done")) {
    if (sid) {
      generating[sid] = false;
      if (streaming[sid]) delete streaming[sid];
    }
    if (sid === currentId) {
      setSending(false);
      renderAbortBtn();
      // Refresh messages to get final content
      fetchMessages(currentId).then(() => renderMessages());
    }
  }
}

// --- Render ---
function renderSessionList() {
  if (!sessions.length) {
    setSessionListHTML('<div class="session-empty">No sessions yet</div>');
    return;
  }
  setSessionListHTML(
    sessions
      .map((s) => {
        const active = s.id === currentId ? " active" : "";
        const title = s.title || s.id?.slice(0, 14) || "untitled";
        const dir = s.directory ? trimDir(s.directory) : "";
        return `<div class="session-item${active}" onclick="selectSession('${esc(s.id)}')">
      <div class="session-info">
        <div class="session-title">${esc(title)}</div>
        ${dir ? `<div class="session-dir">${esc(dir)}</div>` : ""}
      </div>
      <button class="session-del" onclick="deleteSession('${esc(s.id)}', event)" title="Delete">✕</button>
    </div>`;
      })
      .join(""),
  );
}

function setSessionListHTML(html) {
  document.getElementById("sessionList").innerHTML = html;
}

function renderMain() {
  const inputArea = document.getElementById("inputArea");
  if (!currentId) {
    inputArea.classList.remove("visible");
    document.getElementById("messages").innerHTML =
      '<div class="empty-state"><h2>mecodes</h2><p>Select a session or create a new one</p></div>';
    document.getElementById("chatTitle").textContent = "Select a session";
    document.getElementById("chatTitle").className = "chat-title";
    renderAbortBtn();
    return;
  }
  inputArea.classList.add("visible");
  renderChatTitle();
  renderAbortBtn();
}

function renderChatTitle() {
  const s = sessions.find((s) => s.id === currentId);
  const title = s?.title || currentId?.slice(0, 16) || "Session";
  const dir = s?.directory ? ` — ${trimDir(s.directory)}` : "";
  const el = document.getElementById("chatTitle");
  el.textContent = title + dir;
  el.className = "chat-title active";
}

function renderAbortBtn() {
  const btn = document.getElementById("abortBtn");
  if (currentId && generating[currentId]) btn.classList.add("visible");
  else btn.classList.remove("visible");
}

function renderMessages() {
  if (!currentId) return;
  const container = document.getElementById("messages");
  const msgs = messages[currentId] ?? [];
  const stream = streaming[currentId] ?? {};
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  let html = "";
  const renderedMsgIds = new Set();

  for (const msg of msgs) {
    const streamText = stream[msg.id];
    const rendered = renderMsg(msg, streamText);
    if (rendered) {
      html += rendered;
      renderedMsgIds.add(msg.id);
    }
  }

  // Orphan streaming parts (msg not yet in list)
  for (const [msgId, text] of Object.entries(stream)) {
    if (!renderedMsgIds.has(msgId) && text) {
      html += `<div class="msg assistant"><div class="msg-role">assistant</div>${esc(text)}<span class="cursor"></span></div>`;
    }
  }

  if (!html && msgs.length === 0) {
    html =
      '<div style="color:var(--dim);font-size:0.875rem;text-align:center;padding:3rem">Session started — send a message to begin</div>';
  }

  container.innerHTML = html;
  if (atBottom) container.scrollTop = container.scrollHeight;
}

function renderMsg(msg, streamText) {
  const role = msg.role ?? "assistant";
  const parts = msg.parts ?? msg.content ?? [];
  let text = "";

  if (typeof parts === "string") {
    text = parts;
  } else if (Array.isArray(parts)) {
    for (const p of parts) {
      if (p.type === "text") text += p.text ?? "";
      else if (p.type === "tool-invocation" || p.type === "tool-use") {
        const name = p.toolName ?? p.name ?? "tool";
        const input = JSON.stringify(p.input ?? p.args ?? {});
        text += `[${name}(${input.length > 100 ? `${input.slice(0, 100)}…` : input})]`;
      } else if (p.type === "tool-result") {
        const content = p.content;
        const preview = typeof content === "string" ? content : JSON.stringify(content);
        text += `[result: ${preview.length > 120 ? `${preview.slice(0, 120)}…` : preview}]`;
      }
    }
  }

  // Append any in-progress streaming text for this message
  if (streamText && !text.endsWith(streamText)) text += streamText;
  const hasCursor = !!streamText;

  if (!text && !hasCursor) return "";

  const cls = role === "user" ? "user" : role === "tool" ? "tool" : "assistant";
  const cursor = hasCursor ? '<span class="cursor"></span>' : "";
  return `<div class="msg ${cls}"><div class="msg-role">${esc(role)}</div>${esc(text)}${cursor}</div>`;
}

// --- UI helpers ---
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trimDir(dir) {
  const parts = dir.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function setSending(on) {
  document.getElementById("sendBtn").disabled = on;
  document.getElementById("prompt").disabled = on;
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

function toggleNewForm() {
  const f = document.getElementById("newForm");
  f.classList.toggle("visible");
  if (f.classList.contains("visible")) document.getElementById("dirInput").focus();
  document.getElementById("newBtn").classList.toggle("active", f.classList.contains("visible"));
}

function closeNewForm() {
  document.getElementById("newForm").classList.remove("visible");
  document.getElementById("newBtn").classList.remove("active");
  document.getElementById("dirInput").value = "";
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("overlay").classList.remove("visible");
}

// --- Wire up ---
document.getElementById("newBtn").onclick = toggleNewForm;
document.getElementById("createBtn").onclick = createSession;
document.getElementById("sendBtn").onclick = sendPrompt;
document.getElementById("abortBtn").onclick = abortSession;
document.getElementById("menuBtn").onclick = () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("overlay").classList.toggle("visible");
};
document.getElementById("dirInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createSession();
});
document.getElementById("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
document.getElementById("prompt").addEventListener("input", function () {
  autoResize(this);
});

// Expose for inline onclick handlers
window.selectSession = selectSession;
window.deleteSession = deleteSession;

// --- Init ---
checkHealth();
loadSessions();
connectSSE();
setInterval(checkHealth, 30_000);

fetch("/version.json")
  .then((r) => r.json())
  .then((v) => {
    document.getElementById("buildVersion").textContent = `${v.sha} (${v.time})`;
  })
  .catch(() => {});
