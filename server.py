import os
import threading
import time
import webbrowser
from collections import defaultdict, deque
from datetime import date

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import core
import engine

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
ON_VERCEL = bool(os.environ.get("VERCEL"))

# Optional: set MENTORA_ACCESS_CODE on the host to require a code (leave it unset to keep the demo open).
ACCESS_CODE = os.environ.get("MENTORA_ACCESS_CODE", "").strip()
MAX_PER_HOUR = 240          # best-effort limit per visitor address, to protect the AI credits

# Nothing is ever saved on the server: every visitor keeps their own data in their own browser.
core.save_memory = lambda memory: None

app = FastAPI(title="Mentora")
_HITS = defaultdict(deque)


class Body(BaseModel):
    state: dict | None = None
    concept: str = ""
    level: str = "School (grades 6-10)"
    answer: str = ""
    action: str = "ready"
    note: str = ""
    subject: str = ""
    when: str = ""
    sid: str = ""
    messages: list[dict] = []


def guard(request: Request):
    if ACCESS_CODE and request.headers.get("x-access-code", "") != ACCESS_CODE:
        raise HTTPException(status_code=401, detail="ACCESS_CODE_REQUIRED")
    fwd = request.headers.get("x-forwarded-for", "")
    ip = fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    now = time.time()
    hits = _HITS[ip]
    while hits and now - hits[0] > 3600:
        hits.popleft()
    if len(hits) >= MAX_PER_HOUR:
        raise HTTPException(status_code=429, detail="You've used a lot of requests this hour. Please try again a little later.")
    hits.append(now)


def normalize(memory):
    memory.setdefault("weak_topics", {})
    memory.setdefault("notes", [])
    memory.setdefault("scores", [])
    memory.setdefault("exam", None)
    engine.get_rc(memory)
    return memory


def respond(body, fn):
    """Runs fn(memory) with this visitor's own data, then hands the updated data back to their browser."""
    state = body.state or {}
    memory = normalize(state.get("memory") or {})
    token = engine.set_run(state.get("run") or {"stage": "idle"})
    try:
        try:
            view = fn(memory)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)[:200]}")
        new_state = {"memory": memory, "run": engine.get_run_copy()}
        info = engine.app_state(memory)
        info["sessions"] = engine.list_sessions(memory)
        return {"state": new_state, "view": view, "app": info}
    finally:
        engine.reset_run(token)


def _add_note(memory, note):
    if note.strip():
        memory["notes"].append(note.strip()[:500])
    return engine.view(memory)


def _set_exam(memory, subject, when):
    try:
        date.fromisoformat(when)
    except ValueError:
        raise ValueError("Please choose a valid date.")
    memory["exam"] = {"subject": subject.strip()[:60], "date": when}
    return engine.view(memory)


def _delete_all(memory):
    core.clear_memory(memory)
    engine.get_rc(memory)
    engine.reset()
    return engine.view(memory)


# ---------- the page (served from public/ locally; Vercel serves public/ itself) ----------

if not ON_VERCEL and os.path.isdir(os.path.join(PUBLIC_DIR, "static")):
    app.mount("/static", StaticFiles(directory=os.path.join(PUBLIC_DIR, "static")), name="static")


@app.get("/")
def index():
    path = os.path.join(PUBLIC_DIR, "index.html")
    if os.path.exists(path):
        return FileResponse(path)
    return HTMLResponse("<h1>Mentora</h1><p>The page files were not found.</p>", status_code=404)


@app.get("/api/health")
def health():
    return {"ok": True, "access_code_required": bool(ACCESS_CODE)}


# ---------- the API: every call carries the visitor's own data ----------

@app.post("/api/boot", dependencies=[Depends(guard)])
def boot(body: Body):
    return respond(body, lambda m: engine.view(m))


@app.post("/api/rc/start", dependencies=[Depends(guard)])
def rc_start(body: Body):
    concept = body.concept.strip()[:120]
    if not concept:
        raise HTTPException(status_code=400, detail="Please type a concept first.")
    return respond(body, lambda m: engine.start(m, concept, body.level[:40]))


@app.post("/api/rc/submit", dependencies=[Depends(guard)])
def rc_submit(body: Body):
    return respond(body, lambda m: engine.submit(m, body.answer[:2000]))


@app.post("/api/rc/next", dependencies=[Depends(guard)])
def rc_next(body: Body):
    return respond(body, lambda m: engine.advance(m, body.action))


@app.post("/api/rc/reset", dependencies=[Depends(guard)])
def rc_reset(body: Body):
    def go(m):
        engine.reset()
        return engine.view(m)
    return respond(body, go)


@app.post("/api/rc/review/start", dependencies=[Depends(guard)])
def rc_review_start(body: Body):
    return respond(body, lambda m: engine.start_review(m))


@app.post("/api/rc/review/ff", dependencies=[Depends(guard)])
def rc_review_ff(body: Body):
    return respond(body, lambda m: engine.fast_forward(m))


@app.post("/api/rc/session", dependencies=[Depends(guard)])
def rc_session(body: Body):
    return respond(body, lambda m: engine.get_session(m, body.sid))


@app.post("/api/rc/resume", dependencies=[Depends(guard)])
def rc_resume(body: Body):
    return respond(body, lambda m: engine.resume(m, body.sid))


@app.post("/api/note", dependencies=[Depends(guard)])
def add_note(body: Body):
    return respond(body, lambda m: _add_note(m, body.note))


@app.post("/api/exam", dependencies=[Depends(guard)])
def set_exam(body: Body):
    return respond(body, lambda m: _set_exam(m, body.subject, body.when))


@app.post("/api/delete", dependencies=[Depends(guard)])
def delete_all(body: Body):
    return respond(body, _delete_all)


@app.post("/api/chat", dependencies=[Depends(guard)])
def chat(body: Body):
    memory = normalize((body.state or {}).get("memory") or {})
    system_text = core.build_system_prompt(memory) + engine.prompt_addon(memory)
    msgs = [{"role": "system", "content": system_text}]
    for m in body.messages[-20:]:
        if m.get("role") in ("user", "assistant"):
            msgs.append({"role": m["role"], "content": str(m.get("content", ""))[:4000]})

    def gen():
        try:
            for piece in core.stream_ai(msgs):
                yield piece
        except Exception:
            yield "\n\n[Mentora couldn't reach the AI. Please try again.]"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


@app.post("/api/rc/sample", dependencies=[Depends(guard)])
def rc_sample(body: Body):
    return respond(body, lambda m: engine.load_sample(m))
if __name__ == "__main__":
    port = 8000
    threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    print(f"Mentora is running at http://127.0.0.1:{port}  (press Ctrl+C to stop)")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")