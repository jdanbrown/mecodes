"""
ocweb sidecar — git lifecycle, disk usage, orphan process management.
"""
import os
import shutil
import subprocess

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

PROJECTS_DIR = os.environ.get("OCWEB_PROJECTS_DIR", "/vol/projects")
GITHUB_USER = os.environ.get("GITHUB_USER", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

app = FastAPI(title="ocweb sidecar", docs_url="/admin/docs", openapi_url="/admin/openapi.json")


# --- Models (must precede endpoints — FastAPI evaluates type annotations eagerly) ---

class CloneRequest(BaseModel):
    repo: str  # "owner/name"


class WorktreeRequest(BaseModel):
    repo: str
    session_id: str
    branch: str = "main"


# --- Repo endpoints ---

@app.post("/admin/repos/clone")
def clone_repo(req: CloneRequest):
    dest = _repo_dir(req.repo)
    if os.path.exists(dest):
        return {"status": "exists", "path": dest}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    result = _run(["git", "clone", "--bare", _clone_url(req.repo), dest])
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)
    return {"status": "cloned", "path": dest}


@app.delete("/admin/repos/{owner}/{name}")
def delete_repo(owner: str, name: str):
    dest = _repo_dir(f"{owner}/{name}")
    if not os.path.exists(dest):
        raise HTTPException(status_code=404, detail="repo not found")
    shutil.rmtree(dest)
    return {"status": "deleted"}


@app.get("/admin/repos")
def list_repos():
    repos_dir = os.path.join(PROJECTS_DIR, "repos")
    if not os.path.exists(repos_dir):
        return {"repos": []}
    entries = os.listdir(repos_dir)
    repos = [e.replace("__", "/", 1) for e in entries if os.path.isdir(os.path.join(repos_dir, e))]
    return {"repos": repos}


# --- Worktree endpoints ---

@app.post("/admin/worktrees")
def create_worktree(req: WorktreeRequest):
    bare = _repo_dir(req.repo)
    if not os.path.exists(bare):
        raise HTTPException(status_code=404, detail="repo not cloned — clone it first")
    dest = _worktree_dir(req.repo, req.session_id)
    if os.path.exists(dest):
        return {"status": "exists", "path": dest}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    branch_name = f"ocweb/{req.session_id}"
    result = _run(["git", "worktree", "add", "-b", branch_name, dest, req.branch], cwd=bare)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)
    return {"status": "created", "path": dest}


@app.delete("/admin/worktrees/{owner}/{name}/{session_id}")
def delete_worktree(owner: str, name: str, session_id: str):
    bare = _repo_dir(f"{owner}/{name}")
    dest = _worktree_dir(f"{owner}/{name}", session_id)
    if not os.path.exists(dest):
        raise HTTPException(status_code=404, detail="worktree not found")
    _run(["git", "worktree", "remove", "--force", dest], cwd=bare)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    return {"status": "deleted"}


@app.get("/admin/worktrees")
def list_worktrees():
    wt_dir = os.path.join(PROJECTS_DIR, "worktrees")
    if not os.path.exists(wt_dir):
        return {"worktrees": []}
    entries = os.listdir(wt_dir)
    worktrees = []
    for e in entries:
        full = os.path.join(wt_dir, e)
        if os.path.isdir(full):
            parts = e.split("__", 2)
            worktrees.append({
                "repo": f"{parts[0]}/{parts[1]}" if len(parts) >= 2 else e,
                "session_id": parts[2] if len(parts) >= 3 else "",
                "path": full,
            })
    return {"worktrees": worktrees}


# --- Disk & process endpoints ---

@app.get("/admin/disk")
def disk_usage():
    result = _run(["du", "-sh", PROJECTS_DIR])
    total = result.stdout.strip().split("\t")[0] if result.returncode == 0 else "unknown"
    stat = shutil.disk_usage("/vol")
    return {
        "projects_size": total,
        "volume_total": _human(stat.total),
        "volume_used": _human(stat.used),
        "volume_free": _human(stat.free),
    }


@app.get("/admin/processes")
def orphan_processes():
    """Find processes whose parent is PID 1 (orphans), excluding known services."""
    known = {"caddy", "opencode", "uvicorn", "python3", "run"}
    result = _run(["ps", "-eo", "pid,ppid,comm,args", "--no-headers"])
    if result.returncode != 0:
        return {"orphans": []}
    orphans = []
    for line in result.stdout.strip().splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3:
            continue
        pid, ppid, comm = parts[0], parts[1], parts[2]
        args = parts[3] if len(parts) > 3 else ""
        if ppid == "1" and comm not in known:
            orphans.append({"pid": int(pid), "comm": comm, "args": args})
    return {"orphans": orphans}


@app.post("/admin/processes/{pid}/kill")
def kill_process(pid: int):
    try:
        os.kill(pid, 15)  # SIGTERM
    except ProcessLookupError:
        raise HTTPException(status_code=404, detail="process not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")
    return {"status": "killed", "pid": pid}


@app.post("/admin/gc")
def garbage_collect():
    """Prune worktrees for repos, remove orphan worktree dirs."""
    repos_dir = os.path.join(PROJECTS_DIR, "repos")
    if not os.path.exists(repos_dir):
        return {"pruned": 0}
    pruned = 0
    for entry in os.listdir(repos_dir):
        bare = os.path.join(repos_dir, entry)
        if os.path.isdir(bare):
            result = _run(["git", "worktree", "prune"], cwd=bare)
            if result.returncode == 0:
                pruned += 1
    return {"pruned": pruned}


@app.get("/admin/health")
def health():
    return {"status": "ok"}


# --- Helpers ---

def _repo_dir(repo: str) -> str:
    return os.path.join(PROJECTS_DIR, "repos", repo.replace("/", "__"))


def _worktree_dir(repo: str, session_id: str) -> str:
    return os.path.join(PROJECTS_DIR, "worktrees", f"{repo.replace('/', '__')}__{session_id}")


def _clone_url(repo: str) -> str:
    if GITHUB_TOKEN:
        return f"https://{GITHUB_USER}:{GITHUB_TOKEN}@github.com/{repo}.git"
    return f"https://github.com/{repo}.git"


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120, **kwargs)


def _human(nbytes: int) -> str:
    n = float(nbytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"
