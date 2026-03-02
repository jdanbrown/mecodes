import { useEffect, useRef, useState } from "react";
import {
  cloneAndSelectRepo,
  loadRepoPickerData,
  selectRepo,
  setSidebarOpen,
  startNewSession,
  useStore,
} from "../lib/store";

export function TopBar() {
  const { version, sidebarOpen, currentRepo, sessions, currentSessionId } = useStore();

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const sessionLabel = currentSession?.title || (currentSessionId ? currentSessionId.slice(0, 14) : null);

  return (
    <div className="top-bar">
      <button className="top-bar-btn hamburger" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar">
        &#9776;
      </button>
      <div className="top-bar-info">
        <RepoPickerInline />
        {sessionLabel && <div className="top-bar-session">{sessionLabel}</div>}
      </div>
      <span className="top-bar-spacer" />
      {version && <span className="top-bar-version">{version}</span>}
      <a className="top-bar-link" href="/foo" target="_blank" rel="noreferrer" title="Open opencode web UI">
        opencode
      </a>
      {currentRepo && (
        <button className="top-bar-btn new-session" onClick={() => startNewSession()} title="New session">
          +
        </button>
      )}
    </div>
  );
}

function RepoPickerInline() {
  const { currentRepo, clonedRepos, githubRepos } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      loadRepoPickerData();
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const clonedNames = clonedRepos.map((r) => r.name);
  let repos = githubRepos.map((r) => ({
    ...r,
    cloned: clonedNames.includes(r.full_name),
  }));
  if (query) {
    const q = query.toLowerCase();
    repos = repos.filter(
      (r) => r.full_name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
    );
  }

  function pick(fullName: string) {
    setOpen(false);
    const existing = clonedRepos.find((r) => r.name === fullName);
    if (existing) {
      selectRepo(existing);
    } else {
      cloneAndSelectRepo(fullName);
    }
  }

  const label = currentRepo ? currentRepo.name.split("/").pop() : "Select repo...";

  return (
    <div className="top-bar-repo-picker" ref={pickerRef}>
      <button className="top-bar-repo-btn" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="top-bar-repo-dropdown">
          <input
            ref={searchRef}
            className="picker-search"
            placeholder="Search repos..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="picker-list">
            {repos.length === 0 && (
              <div className="picker-empty">{githubRepos.length === 0 && !query ? "Loading..." : "No repos found"}</div>
            )}
            {repos.map((r) => (
              <div
                key={r.full_name}
                className={`picker-item ${currentRepo?.name === r.full_name ? "active" : ""}`}
                onClick={() => pick(r.full_name)}
              >
                <span className="picker-item-name">{r.full_name.split("/").pop()}</span>
                {r.cloned && <span className="badge cloned">cloned</span>}
                {r.private && <span className="badge private">private</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
