// --- State ---
let sessions = [];
let currentId = null;
// sessionId -> [{ info: {id, role, sessionID, ...}, parts: [{type, ...}] }]
const messages = {};
// sessionId -> { partId -> true } (marks parts currently streaming)
const deltas = {};
const generating = {}; // sessionId -> bool

// Currently selected repo: { name: "owner/repo", path: "/vol/projects/repos/owner__repo" }
let currentRepo = null;
// [{ name, path }] from GET /admin/repos
let clonedRepos = [];
let githubRepos = []; // from GET /admin/repos/github
let allWorktrees = []; // from GET /admin/worktrees

// SSE: one EventSource per worktree directory, so we get events from all live sessions.
// directory -> EventSource
const sseStreams = {};

// sessionId -> worktree directory path
// Opencode sessions don't reliably include a directory field, so we track it
// ourselves. Populated when creating sessions and persisted in localStorage.
const sessionDirs = loadSessionDirs();

// Model picker state
let selectedModel = null; // { providerID, modelID, name } or null
let providers = []; // [{ id, name, models: [...] }]
let connectedProviders = [];

// localStorage keys
const LS_FAVORITES = "dancodes:favoriteModels";
const LS_LAST_MODEL = "dancodes:lastModel";
const LS_LAST_REPO = "dancodes:lastRepo";

function loadFavorites() {
  try {
    return JSON.parse(localStorage.getItem(LS_FAVORITES)) || [];
  } catch {
    return [];
  }
}
function saveFavorites(favs) {
  localStorage.setItem(LS_FAVORITES, JSON.stringify(favs));
}
function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`;
}
function loadLastModel() {
  try {
    return JSON.parse(localStorage.getItem(LS_LAST_MODEL));
  } catch {
    return null;
  }
}
function saveLastModel(model) {
  localStorage.setItem(LS_LAST_MODEL, JSON.stringify(model));
}
const LS_SESSION_DIRS = "dancodes:sessionDirs";
function loadSessionDirs() {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSION_DIRS)) || {};
  } catch {
    return {};
  }
}
function saveSessionDirs() {
  localStorage.setItem(LS_SESSION_DIRS, JSON.stringify(sessionDirs));
}

// { name, path } or null
function loadLastRepo() {
  try {
    return JSON.parse(localStorage.getItem(LS_LAST_REPO));
  } catch {
    return null;
  }
}
function saveLastRepo(repo) {
  localStorage.setItem(LS_LAST_REPO, JSON.stringify(repo));
}

// ============================================================================
// API
// ============================================================================

// All opencode API calls that operate on a session/project must include the
// x-opencode-directory header. See README "How opencode directory scoping works".
async function api(method, path, body, { directory } = {}) {
  const opts = { method, headers: {} };
  if (directory) {
    opts.headers["x-opencode-directory"] = directory;
  }
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const t0 = performance.now();
  const dirTag = directory ? ` [dir=${directory}]` : "";
  console.log(`API ${method} ${path}${dirTag}`);
  let r;
  try {
    r = await fetch(path, opts);
  } catch (e) {
    console.error(`API ${method} ${path} network error after ${ms(t0)}:`, e.message);
    throw e;
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error(`API ${method} ${path} ${r.status} after ${ms(t0)}:`, txt);
    throw new Error(`${r.status}: ${txt}`);
  }
  console.log(`API ${method} ${path} ${r.status} in ${ms(t0)}`);
  if (r.status === 204 || r.headers.get("content-length") === "0") return null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return r.json();
  return null;
}
function ms(t0) {
  return `${Math.round(performance.now() - t0)}ms`;
}
const get = (p, opts) => api("GET", p, undefined, opts);
const post = (p, b, opts) => api("POST", p, b, opts);
const del = (p, opts) => api("DELETE", p, undefined, opts);

// Look up the worktree directory for a session (used as x-opencode-directory)
function dirFor(sessionId) {
  if (sessionDirs[sessionId]) return sessionDirs[sessionId];
  const s = sessions.find((s) => s.id === sessionId);
  return s?.directory;
}

// ============================================================================
// Health
// ============================================================================

async function checkHealth() {
  for (const [url, dot] of [
    ["/global/health", "dotOc"],
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

// ============================================================================
// Repo selector (sidebar top)
// ============================================================================

async function selectRepo(repo) {
  currentRepo = repo;
  saveLastRepo(repo);
  renderRepoSelectorBtn();
  closeRepoPicker();

  // Load sessions for this repo using the repo checkout as the directory
  sessions = [];
  currentId = null;
  renderSessionList();
  renderMain();
  await loadSessions();
  syncSSE();
}

function renderRepoSelectorBtn() {
  const btn = document.getElementById("repoSelectorBtn");
  if (currentRepo) {
    btn.textContent = currentRepo.name.split("/").pop();
    btn.title = currentRepo.name;
  } else {
    btn.textContent = "Select a repo…";
    btn.title = "";
  }
}

function openRepoPicker() {
  const picker = document.getElementById("repoSelectorPicker");
  const isOpen = picker.classList.contains("visible");
  if (isOpen) {
    closeRepoPicker();
    return;
  }
  picker.classList.add("visible");
  const search = document.getElementById("repoSelectorSearch");
  search.value = "";
  search.focus();
  renderRepoSelectorList();
  // Fetch latest data in background
  loadRepoPickerData().then(renderRepoSelectorList);
}

function closeRepoPicker() {
  document.getElementById("repoSelectorPicker").classList.remove("visible");
}

async function loadRepoPickerData() {
  try {
    const [ghData, clonedData] = await Promise.all([
      get("/admin/repos/github").catch((e) => {
        console.error("GitHub repos:", e);
        return null;
      }),
      get("/admin/repos"),
    ]);
    githubRepos = ghData?.repos ?? [];
    clonedRepos = clonedData?.repos ?? [];
  } catch (e) {
    console.error("loadRepoPickerData:", e);
  }
}

function renderRepoSelectorList() {
  const container = document.getElementById("repoSelectorList");
  if (!container) return;
  const query = (document.getElementById("repoSelectorSearch")?.value || "").toLowerCase();
  const clonedNames = clonedRepos.map((r) => r.name);

  let repos = githubRepos.map((r) => ({
    ...r,
    cloned: clonedNames.includes(r.full_name),
  }));

  if (query) {
    repos = repos.filter(
      (r) => r.full_name.toLowerCase().includes(query) || (r.description || "").toLowerCase().includes(query),
    );
  }

  if (!repos.length) {
    const msg = githubRepos.length === 0 && !query ? "Loading…" : "No repos found";
    container.innerHTML = `<div class="session-empty">${msg}</div>`;
    return;
  }

  container.innerHTML = repos
    .map((r) => {
      const active = currentRepo?.name === r.full_name ? " active" : "";
      const badge = r.cloned ? '<span class="repo-badge cloned">cloned</span>' : "";
      const priv = r.private ? '<span class="repo-badge private">private</span>' : "";
      const shortName = r.full_name.split("/").pop();
      return `<div class="repo-picker-item${active}" onclick="pickRepo('${esc(r.full_name)}')">
      <span class="repo-picker-name">${esc(shortName)} ${badge} ${priv}</span>
    </div>`;
    })
    .join("");
}

async function pickRepo(fullName) {
  // Ensure repo is cloned so we have a valid directory for opencode
  const existing = clonedRepos.find((r) => r.name === fullName);
  if (existing) {
    await selectRepo(existing);
    return;
  }
  // Clone first
  closeRepoPicker();
  setSessionListHTML('<div class="session-empty">Cloning…</div>');
  try {
    const result = await post("/admin/repos/clone", { repo: fullName });
    const repo = { name: fullName, path: result.path };
    clonedRepos.push(repo);
    await selectRepo(repo);
  } catch (e) {
    alert(`Clone failed: ${e.message}`);
    setSessionListHTML('<div class="session-empty">Clone failed</div>');
  }
}

// ============================================================================
// Sessions
// ============================================================================

async function loadSessions() {
  if (!currentRepo) {
    setSessionListHTML('<div class="session-empty">Select a repo to see sessions</div>');
    return;
  }
  try {
    const [sessionData, wtData] = await Promise.all([
      get("/session", { directory: currentRepo.path }),
      get("/admin/worktrees"),
    ]);
    sessions = Array.isArray(sessionData) ? sessionData : (sessionData?.sessions ?? []);
    allWorktrees = wtData?.worktrees ?? [];

    // Cross-reference sessions with worktrees to populate sessionDirs.
    // Worktree session_id is the suffix we used when creating the worktree (a
    // random UUID fragment), NOT the opencode session ID. But the worktree path
    // is what we used as the directory when creating the opencode session, so
    // the opencode session object might have it in its directory field.
    //
    // Strategy: for each session, check if it already has a directory field.
    // If not, try to find a worktree for this repo whose path we can assign.
    // This is imperfect — if there are multiple worktrees and sessions, we
    // can't reliably match them without a stored mapping. But for now, sessions
    // that were created before sessionDirs existed won't have the mapping.
    let dirsChanged = false;
    for (const s of sessions) {
      if (sessionDirs[s.id]) continue;
      if (s.directory) {
        sessionDirs[s.id] = s.directory;
        dirsChanged = true;
      }
    }
    if (dirsChanged) saveSessionDirs();

    renderSessionList();
  } catch (e) {
    console.error("loadSessions:", e);
    setSessionListHTML('<div class="session-empty">Failed to load sessions</div>');
  }
}

async function deleteSession(id, ev) {
  ev.stopPropagation();
  if (!confirm("Delete this session?")) return;
  const dir = dirFor(id);
  try {
    await del(`/session/${id}`, { directory: dir });
  } catch (e) {
    if (!e.message.startsWith("404")) {
      alert(`Failed: ${e.message}`);
      return;
    }
  }
  sessions = sessions.filter((s) => s.id !== id);
  delete messages[id];
  delete deltas[id];
  delete sessionDirs[id];
  saveSessionDirs();
  if (currentId === id) {
    currentId = null;
    renderMain();
  }
  renderSessionList();
  syncSSE();
}

async function selectSession(id) {
  currentId = id;
  setSending(!!generating[id]);
  renderAbortBtn();
  renderSessionList();
  renderMain();
  closeSidebar();
  if (!messages[id]) await fetchMessages(id);
  renderMessages();
}

async function fetchMessages(id) {
  const dir = dirFor(id);
  try {
    const data = await get(`/session/${id}/message`, { directory: dir });
    messages[id] = Array.isArray(data) ? data : [];
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
  messages[currentId].push({
    info: { id: `opt-${Date.now()}`, role: "user", sessionID: currentId },
    parts: [{ type: "text", text }],
  });
  renderMessages();

  const dir = dirFor(currentId);
  try {
    const body = { parts: [{ type: "text", text }] };
    if (selectedModel) {
      body.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
    }
    await post(`/session/${currentId}/prompt_async`, body, { directory: dir });
    generating[currentId] = true;
    renderAbortBtn();
    renderSessionList();
  } catch (e) {
    setSending(false);
    alert(`Send failed: ${e.message}`);
  }
}

async function abortSession() {
  if (!currentId) return;
  const dir = dirFor(currentId);
  try {
    await post(`/session/${currentId}/abort`, undefined, { directory: dir });
  } catch (e) {
    console.warn("abort:", e);
  }
  generating[currentId] = false;
  setSending(false);
  renderAbortBtn();
  renderSessionList();
}

// ============================================================================
// New session
// ============================================================================

async function startNewSession() {
  if (!currentRepo) {
    openRepoPicker();
    return;
  }
  closeSidebar();
  currentId = null;
  document.getElementById("inputArea").classList.remove("visible");
  document.getElementById("messages").innerHTML =
    `<div class="empty-state"><p>Creating session for ${esc(currentRepo.name.split("/").pop())}…</p></div>`;
  document.getElementById("chatTitle").textContent = "New session";
  document.getElementById("chatTitle").className = "chat-title";

  try {
    // Create worktree
    const wtId = crypto.randomUUID().slice(0, 12);
    const wt = await post("/admin/worktrees", {
      repo: currentRepo.name,
      session_id: wtId,
      branch: "main",
    });

    // Create opencode session using the worktree directory
    const session = await post("/session", undefined, { directory: wt.path });
    sessionDirs[session.id] = wt.path;
    saveSessionDirs();

    if (!sessions.find((x) => x.id === session.id)) sessions.unshift(session);
    renderSessionList();
    await selectSession(session.id);
    syncSSE();
  } catch (e) {
    alert(`Failed: ${e.message}`);
    renderMain();
  }
}

// ============================================================================
// Repos & worktrees management panel
// ============================================================================

async function openReposPanel() {
  const panel = document.getElementById("reposPanel");
  panel.classList.add("visible");
  document.getElementById("reposBtn").classList.add("active");
  await loadReposData();
  renderReposPanel();
}

function closeReposPanel() {
  document.getElementById("reposPanel").classList.remove("visible");
  document.getElementById("reposBtn").classList.remove("active");
}

async function loadReposData() {
  try {
    const [clonedData, wtData] = await Promise.all([get("/admin/repos"), get("/admin/worktrees")]);
    clonedRepos = clonedData?.repos ?? [];
    allWorktrees = wtData?.worktrees ?? [];
  } catch (e) {
    console.error("loadReposData:", e);
  }
}

function renderReposPanel() {
  const container = document.getElementById("reposPanelBody");

  if (!clonedRepos.length) {
    container.innerHTML = '<div class="session-empty">No repos cloned yet</div>';
    return;
  }

  let html = "";
  for (const repo of clonedRepos) {
    const wts = allWorktrees.filter((w) => w.repo === repo.name);
    const [owner, name] = repo.name.split("/");
    html += `<div class="mgmt-repo">
      <div class="mgmt-repo-header">
        <span class="mgmt-repo-name">${esc(repo.name)}</span>
        <button class="session-del visible-always" onclick="deleteRepo('${esc(owner)}', '${esc(name)}')" title="Delete repo">✕</button>
      </div>`;
    if (wts.length) {
      html += '<div class="mgmt-wt-list">';
      for (const wt of wts) {
        html += `<div class="mgmt-wt-item">
          <span class="mgmt-wt-session">${esc(wt.session_id?.slice(0, 14) || "unknown")}</span>
          <button class="session-del visible-always" onclick="deleteWorktree('${esc(owner)}', '${esc(name)}', '${esc(wt.session_id)}')" title="Delete worktree">✕</button>
        </div>`;
      }
      html += "</div>";
    } else {
      html += '<div class="mgmt-wt-empty">No worktrees</div>';
    }
    html += "</div>";
  }

  container.innerHTML = html;
}

async function deleteRepo(owner, name) {
  if (!confirm(`Delete repo ${owner}/${name} and all its worktrees?`)) return;
  try {
    await del(`/admin/repos/${owner}/${name}`);
    await loadReposData();
    renderReposPanel();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

async function deleteWorktree(owner, name, sessionId) {
  if (!confirm(`Delete worktree for session ${sessionId.slice(0, 14)}?`)) return;
  try {
    await del(`/admin/worktrees/${owner}/${name}/${sessionId}`);
    await loadReposData();
    renderReposPanel();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

// ============================================================================
// SSE — one stream per recently-active worktree directory
// ============================================================================

const SSE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Determine which worktree directories need SSE streams (sessions updated
// within the last 24h), connect/disconnect to match, and poll initial status
// for newly connected directories.
function syncSSE() {
  const now = Date.now();
  const needed = new Set();
  for (const s of sessions) {
    const dir = dirFor(s.id);
    if (!dir) continue;
    const updated = s.time_updated ?? s.timeUpdated ?? 0;
    // Treat missing/zero timestamps as "recent" — they're likely brand new sessions
    if (updated === 0 || now - updated < SSE_MAX_AGE_MS) {
      needed.add(dir);
    }
  }

  // Close streams for directories we no longer need
  for (const dir of Object.keys(sseStreams)) {
    if (!needed.has(dir)) {
      console.log(`SSE: closing stream for ${dir}`);
      sseStreams[dir].close();
      delete sseStreams[dir];
    }
  }

  // Open streams for new directories + poll their initial status
  for (const dir of needed) {
    if (!sseStreams[dir]) {
      connectSSEForDir(dir);
      pollSessionStatus(dir);
    }
  }

  renderSSEStatus();
}

function connectSSEForDir(dir) {
  const url = `/event?directory=${encodeURIComponent(dir)}`;
  console.log(`SSE: connecting for ${dir}`);
  const es = new EventSource(url);
  sseStreams[dir] = es;

  es.onopen = () => renderSSEStatus();
  es.onerror = () => renderSSEStatus();
  es.onmessage = (ev) => handleEvent(ev.data);
}

// GET /session/status returns { sessionID: { type: "idle"|"busy"|"retry" } }
// for all sessions in the given directory. This fills in the initial busy/idle
// state that we'd otherwise miss since SSE only delivers future state changes.
async function pollSessionStatus(dir) {
  try {
    const data = await get("/session/status", { directory: dir });
    if (!data) return;
    for (const [sid, status] of Object.entries(data)) {
      generating[sid] = status.type !== "idle";
    }
    renderSessionList();
    if (currentId && generating[currentId] !== undefined) {
      renderAbortBtn();
    }
  } catch (e) {
    console.debug("pollSessionStatus:", e.message);
  }
}

function renderSSEStatus() {
  const el = document.getElementById("sseStatus");
  const dirs = Object.keys(sseStreams);
  if (dirs.length === 0) {
    el.textContent = "";
    return;
  }
  const allOpen = dirs.every((d) => sseStreams[d].readyState === EventSource.OPEN);
  if (allOpen) {
    el.textContent = `● ${dirs.length} stream${dirs.length > 1 ? "s" : ""}`;
    el.style.color = "var(--green)";
  } else {
    el.textContent = "○ reconnecting";
    el.style.color = "var(--orange)";
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

  const type = ev.type ?? "";
  const props = ev.properties ?? {};
  if (type === "server.heartbeat" || type === "server.connected") return;
  console.debug("SSE:", type, props);

  // --- Session events ---
  if (type === "session.created" || type === "session.updated") {
    const info = props.info;
    if (info) {
      const idx = sessions.findIndex((s) => s.id === info.id);
      if (idx >= 0) sessions[idx] = info;
      else if (type === "session.created") sessions.unshift(info);
      renderSessionList();
      if (info.id === currentId) renderChatTitle();
    }
  }

  if (type === "session.status") {
    const sid = props.sessionID;
    const statusType = props.status?.type;
    if (sid && statusType) {
      const isGenerating = statusType !== "idle";
      generating[sid] = isGenerating;
      renderSessionList();
      if (sid === currentId) {
        if (!isGenerating) setSending(false);
        renderAbortBtn();
      }
    }
  }

  if (type === "session.error") {
    const sid = props.sessionID;
    if (sid) {
      generating[sid] = false;
      if (sid === currentId) {
        setSending(false);
        renderAbortBtn();
      }
    }
  }

  // --- Message events ---
  if (type === "message.updated") {
    const info = props.info;
    if (!info) return;
    const sid = info.sessionID;
    if (!sid || !messages[sid]) return;
    const list = messages[sid];
    if (info.role === "user") {
      const optIdx = list.findIndex((m) => m.info.id.startsWith("opt-"));
      if (optIdx >= 0) list.splice(optIdx, 1);
    }
    const idx = list.findIndex((m) => m.info.id === info.id);
    if (idx >= 0) {
      list[idx].info = info;
    } else {
      list.push({ info, parts: [] });
    }
    if (info.role === "assistant" && info.error) {
      const err = info.error;
      const errMsg = err.data?.message ?? err.message ?? err.name ?? "Unknown error";
      const errId = `err-${info.id}`;
      if (!list.find((m) => m.info.id === errId)) {
        list.push({
          info: { id: errId, role: "error", sessionID: sid },
          parts: [{ type: "text", text: errMsg }],
        });
      }
    }
    if (sid === currentId) renderMessages();
  }

  if (type === "message.part.updated") {
    const part = props.part;
    if (!part) return;
    const sid = part.sessionID;
    const msgId = part.messageID;
    if (!sid || !messages[sid]) return;
    const msg = messages[sid].find((m) => m.info.id === msgId);
    if (!msg) return;
    const idx = msg.parts.findIndex((p) => p.id === part.id);
    if (idx >= 0) msg.parts[idx] = part;
    else msg.parts.push(part);
    if (sid === currentId) renderMessages();
  }

  if (type === "message.part.delta") {
    const { sessionID, messageID, partID, field, delta } = props;
    if (!sessionID || !messages[sessionID]) return;
    const msg = messages[sessionID].find((m) => m.info.id === messageID);
    if (msg) {
      const part = msg.parts.find((p) => p.id === partID);
      if (part && field === "text") {
        part.text = (part.text ?? "") + delta;
      }
    }
    if (!deltas[sessionID]) deltas[sessionID] = {};
    deltas[sessionID][partID] = true;
    if (sessionID === currentId) {
      renderMessages();
      requestAnimationFrame(() => {
        if (deltas[sessionID]) delete deltas[sessionID][partID];
      });
    }
  }
}

// ============================================================================
// Model picker
// ============================================================================

async function loadProviders() {
  try {
    const data = await get("/provider");
    const all = data?.all ?? [];
    connectedProviders = data?.connected ?? [];
    const defaults = data?.default ?? {};

    providers = all
      .filter((p) => connectedProviders.includes(p.id))
      .map((p) => {
        const models = Object.values(p.models ?? {}).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
        return { id: p.id, name: p.name ?? p.id, models };
      })
      .filter((p) => p.models.length > 0);

    if (!selectedModel && providers.length > 0) {
      const last = loadLastModel();
      if (last) {
        const p = providers.find((p) => p.id === last.providerID);
        const m = p?.models.find((m) => m.id === last.modelID);
        if (m) selectedModel = { providerID: p.id, modelID: m.id, name: m.name ?? m.id };
      }
      if (!selectedModel) {
        for (const p of providers) {
          const defModelId = defaults[p.id];
          if (defModelId) {
            const m = p.models.find((m) => m.id === defModelId);
            if (m) {
              selectedModel = { providerID: p.id, modelID: m.id, name: m.name ?? m.id };
              break;
            }
          }
        }
      }
      if (!selectedModel) {
        const p = providers[0];
        const m = p.models[0];
        selectedModel = { providerID: p.id, modelID: m.id, name: m.name ?? m.id };
      }
    }
    renderModelBtn();
  } catch (e) {
    console.error("loadProviders:", e);
  }
}

function renderModelBtn() {
  const btn = document.getElementById("modelBtn");
  if (!btn) return;
  btn.textContent = selectedModel ? selectedModel.name : "Model…";
  btn.title = selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : "Select model";
}

function openModelPicker() {
  const panel = document.getElementById("modelPanel");
  panel.classList.toggle("visible");
  if (panel.classList.contains("visible")) {
    const search = document.getElementById("modelSearch");
    if (search) search.value = "";
    renderModelPicker();
    if (search) search.focus();
  }
}

function closeModelPicker() {
  document.getElementById("modelPanel").classList.remove("visible");
}

function renderModelPicker() {
  const container = document.getElementById("modelList");
  if (!providers.length) {
    container.innerHTML = '<div class="session-empty">No providers connected</div>';
    return;
  }
  const query = (document.getElementById("modelSearch")?.value || "").toLowerCase();
  const queryWords = query.split(/\s+/).filter(Boolean);
  const favs = loadFavorites();

  const allModels = [];
  for (const p of providers) {
    for (const m of p.models) {
      const name = m.name ?? m.id;
      const searchable = `${p.id}/${m.id}`.toLowerCase();
      if (queryWords.length > 0 && !queryWords.every((w) => searchable.includes(w))) continue;
      allModels.push({ provider: p, model: m, name, key: modelKey(p.id, m.id) });
    }
  }

  const favoriteModels = allModels.filter((x) => favs.includes(x.key));
  const restModels = allModels.filter((x) => !favs.includes(x.key));

  function renderModelItem(providerID, m, name, isFav) {
    const active = selectedModel?.providerID === providerID && selectedModel?.modelID === m.id ? " active" : "";
    const starCls = isFav ? "model-star starred" : "model-star";
    return `<div class="model-item${active}" onclick="pickModel('${esc(providerID)}', '${esc(m.id)}', '${esc(name)}')">
      <button class="${starCls}" onclick="toggleFavorite('${esc(providerID)}', '${esc(m.id)}', event)" title="${isFav ? "Remove from favorites" : "Add to favorites"}">&#9733;</button>
      <span class="model-name">${esc(name)}</span>
    </div>`;
  }

  let html = "";
  if (favoriteModels.length > 0) {
    html += '<div class="model-provider">Favorites</div>';
    for (const x of favoriteModels) html += renderModelItem(x.provider.id, x.model, x.name, true);
  }
  const grouped = new Map();
  for (const x of restModels) {
    if (!grouped.has(x.provider.id)) grouped.set(x.provider.id, { provider: x.provider, models: [] });
    grouped.get(x.provider.id).models.push(x);
  }
  for (const [, group] of grouped) {
    html += `<div class="model-provider">${esc(group.provider.name)}</div>`;
    for (const x of group.models) html += renderModelItem(group.provider.id, x.model, x.name, false);
  }
  if (!html) html = '<div class="session-empty">No models match</div>';
  container.innerHTML = html;
}

function pickModel(providerID, modelID, name) {
  selectedModel = { providerID, modelID, name };
  saveLastModel(selectedModel);
  renderModelBtn();
  closeModelPicker();
}

function toggleFavorite(providerID, modelID, ev) {
  ev.stopPropagation();
  const key = modelKey(providerID, modelID);
  const favs = loadFavorites();
  const idx = favs.indexOf(key);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(key);
  saveFavorites(favs);
  renderModelPicker();
}

// ============================================================================
// Render
// ============================================================================

function renderSessionList() {
  if (!currentRepo) {
    setSessionListHTML('<div class="session-empty">Select a repo to see sessions</div>');
    return;
  }
  if (!sessions.length) {
    setSessionListHTML('<div class="session-empty">No sessions yet</div>');
    return;
  }
  // Sort by most recently updated first
  const sorted = [...sessions].sort((a, b) => {
    const ta = a.time_updated ?? a.timeUpdated ?? 0;
    const tb = b.time_updated ?? b.timeUpdated ?? 0;
    return tb - ta;
  });
  setSessionListHTML(
    sorted
      .map((s) => {
        const active = s.id === currentId ? " active" : "";
        const title = s.title || s.id?.slice(0, 14) || "untitled";
        const busy = generating[s.id] ? '<span class="session-spinner"></span>' : "";
        const updated = s.time_updated ?? s.timeUpdated ?? 0;
        const ago = updated ? timeAgo(updated) : "";
        return `<div class="session-item${active}" onclick="selectSession('${esc(s.id)}')">
      <div class="session-info">
        <div class="session-title">${busy}${esc(title)}</div>
        ${ago ? `<div class="session-time">${esc(ago)}</div>` : ""}
      </div>
    </div>`;
      })
      .join(""),
  );
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function setSessionListHTML(html) {
  document.getElementById("sessionList").innerHTML = html;
}

function renderMain() {
  const inputArea = document.getElementById("inputArea");
  const promptRow = document.getElementById("promptRow");
  if (!currentId) {
    inputArea.classList.add("visible");
    promptRow.classList.add("hidden");
    const msg = currentRepo ? "Select a session or create a new one" : "Select a repo, then start a session";
    document.getElementById("messages").innerHTML = `<div class="empty-state"><h2>dancodes</h2><p>${msg}</p></div>`;
    document.getElementById("chatTitle").textContent = "Select a session";
    document.getElementById("chatTitle").className = "chat-title";
    renderAbortBtn();
    return;
  }
  inputArea.classList.add("visible");
  promptRow.classList.remove("hidden");
  renderChatTitle();
  renderAbortBtn();
}

function renderChatTitle() {
  const s = sessions.find((s) => s.id === currentId);
  const title = s?.title || currentId?.slice(0, 16) || "Session";
  const el = document.getElementById("chatTitle");
  el.textContent = title;
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
  const activeDelta = deltas[currentId] ?? {};
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  let html = "";
  for (const msg of msgs) html += renderMsg(msg, activeDelta);

  if (!html) {
    html =
      '<div style="color:var(--dim);font-size:0.875rem;text-align:center;padding:3rem">Session started — send a message to begin</div>';
  }

  container.innerHTML = html;
  if (atBottom) container.scrollTop = container.scrollHeight;
}

function renderMsg(msg, activeDelta) {
  const info = msg.info;
  const parts = msg.parts ?? [];
  const role = info.role ?? "assistant";

  if (role === "user") {
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    if (!text) return "";
    return `<div class="msg user"><div class="msg-role">user</div>${esc(text)}</div>`;
  }

  if (role === "error") {
    const text = parts.map((p) => p.text ?? "").join("");
    return `<div class="msg error"><div class="msg-role">error</div>${esc(text)}</div>`;
  }

  let partHtml = "";
  for (const p of parts) {
    const isStreaming = activeDelta[p.id];
    const cursor = isStreaming ? '<span class="cursor"></span>' : "";

    if (p.type === "text") {
      partHtml += `<div class="msg-part text">${esc(p.text ?? "")}${cursor}</div>`;
    } else if (p.type === "reasoning") {
      partHtml += `<div class="msg-part reasoning">${esc(p.text ?? "")}${cursor}</div>`;
    } else if (p.type === "tool") {
      partHtml += renderToolPart(p);
    } else if (p.type === "step-finish") {
      const tokens = p.tokens;
      if (tokens) {
        const inp = tokens.input ?? 0;
        const out = tokens.output ?? 0;
        const cached = tokens.cache?.read ?? 0;
        partHtml += `<div class="msg-part step-finish">${inp + out} tokens (${inp} in, ${out} out${cached ? `, ${cached} cached` : ""})</div>`;
      }
    }
  }

  if (!partHtml) return "";
  const modelLabel = info.modelID ? `<span class="msg-model">${esc(info.modelID)}</span>` : "";
  return `<div class="msg assistant"><div class="msg-role">assistant ${modelLabel}</div>${partHtml}</div>`;
}

function renderToolPart(p) {
  const tool = p.tool ?? "tool";
  const state = p.state;
  if (!state) return "";

  const status = state.status;
  const title = state.title ?? tool;

  if (status === "pending" || status === "running") {
    return `<div class="msg-part tool running">${esc(title)} <span class="cursor"></span></div>`;
  }
  if (status === "completed") {
    const output = state.output ?? "";
    const preview = output.length > 200 ? `${output.slice(0, 200)}…` : output;
    return `<div class="msg-part tool completed"><div class="tool-title">${esc(title)}</div><div class="tool-output">${esc(preview)}</div></div>`;
  }
  if (status === "error") {
    return `<div class="msg-part tool errored"><div class="tool-title">${esc(title)}</div><div class="tool-error">${esc(state.error ?? "error")}</div></div>`;
  }
  return "";
}

// ============================================================================
// UI helpers
// ============================================================================

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setSending(on) {
  document.getElementById("sendBtn").disabled = on;
  document.getElementById("prompt").disabled = on;
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("overlay").classList.remove("visible");
}

// ============================================================================
// Wire up
// ============================================================================

document.getElementById("newBtn").onclick = startNewSession;
document.getElementById("reposBtn").onclick = openReposPanel;
document.getElementById("reposPanelClose").onclick = closeReposPanel;
document.getElementById("sendBtn").onclick = sendPrompt;
document.getElementById("abortBtn").onclick = abortSession;
document.getElementById("modelBtn").onclick = openModelPicker;
document.getElementById("repoSelectorSearch").addEventListener("input", renderRepoSelectorList);
document.getElementById("menuBtn").onclick = () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("overlay").classList.toggle("visible");
};
document.getElementById("modelSearch").addEventListener("input", renderModelPicker);
document.getElementById("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
document.getElementById("prompt").addEventListener("input", function () {
  autoResize(this);
});

// iOS Safari scrolls the page when focusing an input (to center it on screen),
// which pushes the top bar off-screen. Counter this by scrolling back to top.
window.addEventListener("scroll", () => {
  if (window.scrollY !== 0) window.scrollTo(0, 0);
});

// Close pickers when clicking outside
document.addEventListener("click", (e) => {
  const modelPanel = document.getElementById("modelPanel");
  const modelBtn = document.getElementById("modelBtn");
  if (modelPanel.classList.contains("visible") && !modelPanel.contains(e.target) && e.target !== modelBtn) {
    closeModelPicker();
  }
  const repoPicker = document.getElementById("repoSelectorPicker");
  const repoBtn = document.getElementById("repoSelectorBtn");
  if (repoPicker.classList.contains("visible") && !repoPicker.contains(e.target) && e.target !== repoBtn) {
    closeRepoPicker();
  }
});

// Expose for inline onclick handlers
window.selectSession = selectSession;
window.deleteSession = deleteSession;
window.startNewSession = startNewSession;
window.deleteRepo = deleteRepo;
window.deleteWorktree = deleteWorktree;
window.pickModel = pickModel;
window.toggleFavorite = toggleFavorite;
window.pickRepo = pickRepo;
window.openRepoPicker = openRepoPicker;

// ============================================================================
// Init
// ============================================================================

renderMain();
renderRepoSelectorBtn();
checkHealth();
loadProviders();
setInterval(checkHealth, 30_000);

// Restore last repo and load its sessions
const savedRepo = loadLastRepo();
if (savedRepo) {
  // Verify the saved repo is still cloned
  get("/admin/repos")
    .then((data) => {
      clonedRepos = data?.repos ?? [];
      const found = clonedRepos.find((r) => r.name === savedRepo.name);
      if (found) {
        selectRepo(found);
      }
    })
    .catch((e) => console.error("init:", e));
}

fetch("/version.json")
  .then((r) => r.json())
  .then((v) => {
    document.getElementById("buildVersion").textContent = `${v.sha} (${v.time})`;
  })
  .catch(() => {});
