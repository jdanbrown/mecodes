// --- State ---
let sessions = [];
let currentId = null;
// sessionId -> [{ info: {id, role, sessionID, ...}, parts: [{type, ...}] }]
const messages = {};
// sessionId -> { partId -> accumulated delta text } (for streaming)
const deltas = {};
const generating = {}; // sessionId -> bool
let sse = null;

let githubRepos = []; // cached from /admin/repos/github
let clonedRepos = []; // cached from /admin/repos
let allWorktrees = []; // cached from /admin/worktrees

// Model picker state
// { providerID, modelID, name } or null (use server default)
let selectedModel = null;
// [{ id, name, models: [{ id, providerID, name, ... }] }]
let providers = [];
let connectedProviders = []; // provider IDs that are connected

// Favorites + last model + last repo (localStorage-backed)
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

// { full_name, default_branch } or null
function loadLastRepo() {
  try {
    return JSON.parse(localStorage.getItem(LS_LAST_REPO));
  } catch {
    return null;
  }
}

function saveLastRepo(repo) {
  localStorage.setItem(LS_LAST_REPO, JSON.stringify(repo));
  renderRepoBtn();
}

// --- Model picker ---
async function loadProviders() {
  try {
    const data = await get("/provider");
    const all = data?.all ?? [];
    connectedProviders = data?.connected ?? [];
    const defaults = data?.default ?? {};

    // Flatten: only show connected providers, extract models into arrays
    providers = all
      .filter((p) => connectedProviders.includes(p.id))
      .map((p) => {
        const models = Object.values(p.models ?? {}).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
        return { id: p.id, name: p.name ?? p.id, models };
      })
      .filter((p) => p.models.length > 0);

    // Auto-select: restore last-used model from localStorage, else provider default
    if (!selectedModel && providers.length > 0) {
      const last = loadLastModel();
      if (last) {
        const p = providers.find((p) => p.id === last.providerID);
        const m = p?.models.find((m) => m.id === last.modelID);
        if (m) {
          selectedModel = { providerID: p.id, modelID: m.id, name: m.name ?? m.id };
        }
      }
      // Fallback: first connected provider's default model
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
      // Fallback: first model of first provider
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
  const label = selectedModel ? selectedModel.name : "Model…";
  btn.textContent = label;
  btn.title = selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : "Select model";
}

function openModelPicker() {
  const panel = document.getElementById("modelPanel");
  panel.classList.toggle("visible");
  if (panel.classList.contains("visible")) {
    const searchInput = document.getElementById("modelSearch");
    if (searchInput) searchInput.value = "";
    renderModelPicker();
    if (searchInput) searchInput.focus();
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

  const searchInput = document.getElementById("modelSearch");
  const query = (searchInput?.value || "").toLowerCase();
  const favs = loadFavorites();

  // Collect all models with provider info, filter by search
  // Search matches against "providerID/modelID" so e.g. "openrouter haiku 4" works
  const queryWords = query.split(/\s+/).filter(Boolean);
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

  let html = "";

  function renderModelItem(providerID, m, name, isFav) {
    const active = selectedModel?.providerID === providerID && selectedModel?.modelID === m.id ? " active" : "";
    const starCls = isFav ? "model-star starred" : "model-star";
    return `<div class="model-item${active}" onclick="pickModel('${esc(providerID)}', '${esc(m.id)}', '${esc(name)}')">
      <button class="${starCls}" onclick="toggleFavorite('${esc(providerID)}', '${esc(m.id)}', event)" title="${isFav ? "Remove from favorites" : "Add to favorites"}">&#9733;</button>
      <span class="model-name">${esc(name)}</span>
    </div>`;
  }

  if (favoriteModels.length > 0) {
    html += '<div class="model-provider">Favorites</div>';
    for (const x of favoriteModels) {
      html += renderModelItem(x.provider.id, x.model, x.name, true);
    }
  }

  // Group rest by provider
  const grouped = new Map();
  for (const x of restModels) {
    if (!grouped.has(x.provider.id)) grouped.set(x.provider.id, { provider: x.provider, models: [] });
    grouped.get(x.provider.id).models.push(x);
  }
  for (const [, group] of grouped) {
    html += `<div class="model-provider">${esc(group.provider.name)}</div>`;
    for (const x of group.models) {
      html += renderModelItem(group.provider.id, x.model, x.name, false);
    }
  }

  if (!html) {
    html = '<div class="session-empty">No models match</div>';
  }

  container.innerHTML = html;
}

function pickModel(providerID, modelID, name) {
  selectedModel = { providerID, modelID, name };
  saveLastModel(selectedModel);
  renderModelBtn();
  closeModelPicker();
}

// --- Repo picker (input area widget) ---
function renderRepoBtn() {
  const btn = document.getElementById("repoBtn");
  if (!btn) return;
  const last = loadLastRepo();
  const label = last ? last.full_name.split("/").pop() : "Repo…";
  btn.textContent = label;
  btn.title = last ? last.full_name : "Select repo for new sessions";
}

function openRepoPicker() {
  const panel = document.getElementById("repoPickerPanel");
  panel.classList.toggle("visible");
  if (panel.classList.contains("visible")) {
    const searchInput = document.getElementById("repoPickerSearch");
    if (searchInput) searchInput.value = "";
    renderRepoPickerList();
    if (searchInput) searchInput.focus();
    // Load data in background, re-render when ready
    loadRepoPickerData().then(renderRepoPickerList);
  }
}

function closeRepoPicker() {
  document.getElementById("repoPickerPanel").classList.remove("visible");
}

function renderRepoPickerList() {
  const container = document.getElementById("repoPickerList");
  if (!container) return;
  const query = (document.getElementById("repoPickerSearch")?.value || "").toLowerCase();
  const lastRepo = loadLastRepo();

  let repos = githubRepos.map((r) => ({
    ...r,
    cloned: clonedRepos.includes(r.full_name),
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
      const active = lastRepo?.full_name === r.full_name ? " active" : "";
      const badge = r.cloned ? '<span class="repo-badge cloned">cloned</span>' : "";
      return `<div class="repo-picker-item${active}" onclick="pickRepo('${esc(r.full_name)}', '${esc(r.default_branch)}')">
      <span class="repo-picker-name">${esc(r.full_name)}</span> ${badge}
    </div>`;
    })
    .join("");
}

function pickRepo(fullName, defaultBranch) {
  saveLastRepo({ full_name: fullName, default_branch: defaultBranch });
  closeRepoPicker();
}

// --- API ---
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const t0 = performance.now();
  console.log(`API ${method} ${path}`);
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
    sessions = Array.isArray(data) ? data : (data?.sessions ?? []);
    renderSessionList();
  } catch (e) {
    console.error("loadSessions:", e);
    setSessionListHTML('<div class="session-empty">Failed to load sessions</div>');
  }
}

async function deleteSession(id, ev) {
  ev.stopPropagation();
  if (!confirm("Delete this session?")) return;
  try {
    await del(`/session/${id}`);
  } catch (e) {
    if (!e.message.startsWith("404")) {
      alert(`Failed: ${e.message}`);
      return;
    }
  }
  sessions = sessions.filter((s) => s.id !== id);
  delete messages[id];
  delete deltas[id];
  if (currentId === id) {
    currentId = null;
    renderMain();
  }
  renderSessionList();
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
  try {
    const data = await get(`/session/${id}/message`);
    // v2 format: [{ info: {id, role, ...}, parts: [...] }]
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

  try {
    const body = { parts: [{ type: "text", text }] };
    if (selectedModel) {
      body.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
    }
    await post(`/session/${currentId}/prompt_async`, body);
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

// --- New session flow ---
const repPickerHTML = [
  '<div class="repo-search-wrap">',
  '  <input class="form-input" id="repoSearch" placeholder="Search repos…" autocomplete="off" spellcheck="false">',
  "</div>",
  '<div class="repo-list" id="repoList">',
  '  <div class="session-empty">Loading repos…</div>',
  "</div>",
].join("\n");

async function openNewPanel() {
  // If we have a last-used repo, skip the picker and auto-start
  const lastRepo = loadLastRepo();
  if (lastRepo) {
    closeReposPanel();
    closeSidebar();
    // Show progress in the main empty-state area
    currentId = null;
    document.getElementById("inputArea").classList.remove("visible");
    document.getElementById("messages").innerHTML =
      `<div class="empty-state"><p>Setting up ${esc(lastRepo.full_name)}…</p></div>`;
    document.getElementById("chatTitle").textContent = "New session";
    document.getElementById("chatTitle").className = "chat-title";
    await startNewSession(lastRepo.full_name, lastRepo.default_branch);
    // On failure, startNewSession shows an alert but doesn't throw — restore UI
    if (!currentId) renderMain();
    return;
  }
  openRepoPickerPanel();
}

function openRepoPickerPanel() {
  closeReposPanel();
  // Restore repo picker DOM in case a previous startNewSession replaced it with progress text
  document.getElementById("newPanelBody").innerHTML = repPickerHTML;
  document.getElementById("newPanel").classList.add("visible");
  document.getElementById("newBtn").classList.add("active");
  document.getElementById("repoSearch").value = "";
  document.getElementById("repoSearch").focus();
  loadRepoPickerData().then(renderRepoPicker);
}

function closeNewPanel() {
  document.getElementById("newPanel").classList.remove("visible");
  document.getElementById("newBtn").classList.remove("active");
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

function renderRepoPicker() {
  const query = (document.getElementById("repoSearch").value || "").toLowerCase();
  const container = document.getElementById("repoList");

  let repos = githubRepos.map((r) => ({
    ...r,
    cloned: clonedRepos.includes(r.full_name),
  }));

  if (query) {
    repos = repos.filter(
      (r) => r.full_name.toLowerCase().includes(query) || (r.description || "").toLowerCase().includes(query),
    );
  }

  if (!repos.length) {
    const msg = githubRepos.length === 0 && !query ? "No repos available — check GITHUB_TOKEN?" : "No repos found";
    container.innerHTML = `<div class="session-empty">${msg}</div>`;
    return;
  }

  container.innerHTML = repos
    .map((r) => {
      const badge = r.cloned ? '<span class="repo-badge cloned">cloned</span>' : "";
      const priv = r.private ? '<span class="repo-badge private">private</span>' : "";
      return `<div class="repo-item" onclick="startNewSession('${esc(r.full_name)}', '${esc(r.default_branch)}')">
      <div class="repo-item-info">
        <div class="repo-item-name">${esc(r.full_name)} ${badge} ${priv}</div>
        ${r.description ? `<div class="repo-item-desc">${esc(r.description)}</div>` : ""}
      </div>
    </div>`;
    })
    .join("");
}

async function startNewSession(repoFullName, defaultBranch) {
  saveLastRepo({ full_name: repoFullName, default_branch: defaultBranch });

  const panel = document.getElementById("newPanelBody");
  panel.innerHTML = `<div class="session-empty">Setting up ${esc(repoFullName)}…</div>`;

  try {
    if (!clonedRepos.includes(repoFullName)) {
      panel.innerHTML = `<div class="session-empty">Cloning ${esc(repoFullName)}…</div>`;
      await post("/admin/repos/clone", { repo: repoFullName });
      clonedRepos.push(repoFullName);
    }

    panel.innerHTML = `<div class="session-empty">Creating worktree…</div>`;
    const wtId = crypto.randomUUID().slice(0, 12);
    const wt = await post("/admin/worktrees", {
      repo: repoFullName,
      session_id: wtId,
      branch: defaultBranch || "main",
    });

    panel.innerHTML = `<div class="session-empty">Creating session…</div>`;
    const session = await post("/session", { directory: wt.path });

    if (!sessions.find((x) => x.id === session.id)) sessions.unshift(session);
    renderSessionList();
    await selectSession(session.id);
    closeNewPanel();
  } catch (e) {
    alert(`Failed: ${e.message}`);
    // openNewPanel() will restore the repo picker HTML next time it's opened
  }
}

// --- Repos & worktrees management panel ---
async function openReposPanel() {
  closeNewPanel();
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
    const wts = allWorktrees.filter((w) => w.repo === repo);
    const [owner, name] = repo.split("/");
    html += `<div class="mgmt-repo">
      <div class="mgmt-repo-header">
        <span class="mgmt-repo-name">${esc(repo)}</span>
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
  // opencode sends all events as unnamed SSE messages (no "event:" field),
  // so onmessage catches everything
  sse.onmessage = (ev) => handleEvent(ev.data);
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
    // Remove optimistic messages when real user message arrives
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
    // Assistant message with error — add as error message
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

  // Part created or updated — upsert into the message's parts array
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

  // Streaming text delta — append to the part's text field
  if (type === "message.part.delta") {
    const { sessionID, messageID, partID, field, delta } = props;
    if (!sessionID || sessionID !== currentId) return;
    if (!messages[sessionID]) return;
    const msg = messages[sessionID].find((m) => m.info.id === messageID);
    if (msg) {
      const part = msg.parts.find((p) => p.id === partID);
      if (part && field === "text") {
        part.text = (part.text ?? "") + delta;
      }
    }
    // Also track in deltas for cursor rendering
    if (!deltas[sessionID]) deltas[sessionID] = {};
    deltas[sessionID][partID] = true;
    renderMessages();
    // Clear delta flag after render so cursor disappears when streaming stops
    requestAnimationFrame(() => {
      if (deltas[sessionID]) delete deltas[sessionID][partID];
    });
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
        const busy = generating[s.id] ? '<span class="session-spinner"></span>' : "";
        return `<div class="session-item${active}" onclick="selectSession('${esc(s.id)}')">
      <div class="session-info">
        <div class="session-title">${busy}${esc(title)}</div>
        ${dir ? `<div class="session-dir">${esc(dir)}</div>` : ""}
      </div>
      <!-- delete button disabled: too easy to fat-finger on mobile
      <button class="session-del" onclick="deleteSession('${esc(s.id)}', event)" title="Delete">✕</button>
      -->
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
  const promptRow = document.getElementById("promptRow");
  if (!currentId) {
    inputArea.classList.add("visible");
    promptRow.classList.add("hidden");
    document.getElementById("messages").innerHTML =
      '<div class="empty-state"><h2>dancodes</h2><p>Select a session or create a new one</p></div>';
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
  const activeDelta = deltas[currentId] ?? {};
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  let html = "";
  for (const msg of msgs) {
    html += renderMsg(msg, activeDelta);
  }

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
    const textParts = parts.filter((p) => p.type === "text");
    const text = textParts.map((p) => p.text ?? "").join("");
    if (!text) return "";
    return `<div class="msg user"><div class="msg-role">user</div>${esc(text)}</div>`;
  }

  if (role === "error") {
    const text = parts.map((p) => p.text ?? "").join("");
    return `<div class="msg error"><div class="msg-role">error</div>${esc(text)}</div>`;
  }

  // Assistant message — render each part
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
    // step-start, snapshot, patch, compaction, agent — skip (internal)
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

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("overlay").classList.remove("visible");
}

// --- Wire up ---
document.getElementById("newBtn").onclick = openNewPanel;
document.getElementById("newPanelClose").onclick = closeNewPanel;
document.getElementById("reposBtn").onclick = openReposPanel;
document.getElementById("reposPanelClose").onclick = closeReposPanel;
document.getElementById("sendBtn").onclick = sendPrompt;
document.getElementById("abortBtn").onclick = abortSession;
document.getElementById("modelBtn").onclick = openModelPicker;
document.getElementById("repoBtn").onclick = openRepoPicker;
document.getElementById("repoPickerSearch").addEventListener("input", renderRepoPickerList);
document.getElementById("menuBtn").onclick = () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("overlay").classList.toggle("visible");
};
document.getElementById("repoSearch").addEventListener("input", renderRepoPicker);
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

// Close pickers when clicking outside
document.addEventListener("click", (e) => {
  const modelPanel = document.getElementById("modelPanel");
  const modelBtn = document.getElementById("modelBtn");
  if (modelPanel.classList.contains("visible") && !modelPanel.contains(e.target) && e.target !== modelBtn) {
    closeModelPicker();
  }
  const repoPanel = document.getElementById("repoPickerPanel");
  const repoBtn = document.getElementById("repoBtn");
  if (repoPanel.classList.contains("visible") && !repoPanel.contains(e.target) && e.target !== repoBtn) {
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

// --- Init ---
renderMain();
checkHealth();
loadSessions();
loadProviders();
renderRepoBtn();
connectSSE();
setInterval(checkHealth, 30_000);

fetch("/version.json")
  .then((r) => r.json())
  .then((v) => {
    document.getElementById("buildVersion").textContent = `${v.sha} (${v.time})`;
  })
  .catch(() => {});
