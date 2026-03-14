import { selectSession, sortedSessions, startNewSession, timeAgo, useStore } from "../lib/store";
import type { Repo } from "../lib/types";

export function Sidebar() {
  const { sidebarOpen, version, opencodeVersion, currentRepo, sessions, currentSessionId, generating } = useStore();

  return (
    <div className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <SessionList
        sessions={sessions}
        currentSessionId={currentSessionId}
        generating={generating}
        currentRepo={currentRepo}
      />
      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <div className="sidebar-footer-versions">
            {version && (
              <span className="sidebar-footer-version">
                <a
                  className="sidebar-footer-link"
                  href="https://github.com/jdanbrown/dancodes"
                  target="_blank"
                  rel="noreferrer"
                >
                  dancodes
                </a>{" "}
                <a
                  className="sidebar-footer-link"
                  href={`https://github.com/jdanbrown/dancodes/commit/${version.sha}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {version.sha}
                </a>{" "}
                ({version.time})
              </span>
            )}
            {opencodeVersion && <span className="sidebar-footer-version">opencode {opencodeVersion}</span>}
            <a className="sidebar-footer-link" href="https://app.opencode.ai" target="_blank" rel="noreferrer">
              app.opencode.ai &#8599;
            </a>
          </div>
          {currentRepo && (
            <span className="sidebar-new-btn" onClick={() => startNewSession()}>
              +
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionList(props: {
  sessions: import("../lib/types").Session[];
  currentSessionId: string | null;
  generating: Record<string, boolean>;
  currentRepo: Repo | null;
}) {
  const { currentSessionId, generating, currentRepo } = props;
  const sorted = sortedSessions();

  if (!currentRepo || sorted.length === 0) {
    return <div className="sidebar-empty">No sessions</div>;
  }

  return (
    <div className="session-list">
      {sorted.map((s) => {
        const title = s.title || s.id?.slice(0, 14) || "untitled";
        const updated = s.time_updated ?? s.timeUpdated ?? 0;
        const ago = updated ? timeAgo(updated) : "";
        const active = s.id === currentSessionId;
        const busy = generating[s.id];

        return (
          <div key={s.id} className={`session-item ${active ? "active" : ""}`} onClick={() => selectSession(s.id)}>
            <div className="session-info">
              <div className="session-title">
                {busy && <span className="spinner" />}
                {title}
              </div>
              {ago && <div className="session-time">{ago}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
