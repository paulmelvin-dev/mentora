import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import core

import contextvars
from collections.abc import MutableMapping

_RUN_CV = contextvars.ContextVar("mentora_run")


class _RunState(MutableMapping):
    """The current visitor's diagnosis state. Every web request gets its own private copy."""

    def _d(self):
        try:
            return _RUN_CV.get()
        except LookupError:
            d = {"stage": "idle"}
            _RUN_CV.set(d)
            return d

    def __getitem__(self, key):
        return self._d()[key]

    def __setitem__(self, key, value):
        self._d()[key] = value

    def __delitem__(self, key):
        del self._d()[key]

    def __iter__(self):
        return iter(self._d())

    def __len__(self):
        return len(self._d())

    def clear(self):
        self._d().clear()


RUN = _RunState()


def set_run(run):
    return _RUN_CV.set(json.loads(json.dumps(run or {"stage": "idle"})))


def get_run_copy():
    return json.loads(json.dumps(dict(RUN)))


def reset_run(token):
    _RUN_CV.reset(token)

REVEAL_STRONG = True          # True: the stronger model writes the full answers (slower, more careful)
INTERVALS = [1, 3, 7, 14]     # days until each re-check of a fixed gap

IDK_EXACT = {
    "idk", "i dont know", "i don't know", "i do not know", "dont know", "don't know",
    "no idea", "i have no idea", "not sure", "i'm not sure", "im not sure", "dunno",
    "no clue", "i have no clue", "skip", "n/a", "?", "??",
}
IDK_START = ("i dont know", "i don't know", "i do not know", "no idea", "idk", "dont know", "don't know", "dunno")


def is_idk(answer):
    raw = (answer or "").strip()
    if not raw:
        return True
    a = raw.lower().replace("’", "'")
    a = re.sub(r"[^a-z0-9' ?/]", "", a)
    a = re.sub(r"\s+", " ", a).strip()
    if not re.search(r"[a-z0-9]", a):
        return True          # only symbols such as "?" or "..."
    return a in IDK_EXACT or any(a.startswith(p + " ") for p in IDK_START)


def _log(question, answer, node, raw_reply, correct):
    """Keeps a small log of every grading decision so rare mistakes can be traced."""
    try:
        with open(core.BASE_DIR + "/grading_log.txt", "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "time": time.strftime("%H:%M:%S"), "node": node, "question": question,
                "answer": answer, "correct": correct, "ai_reply": raw_reply,
            }, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _parallel(jobs):
    """jobs = {name: (function, arg1, arg2, ...)}. Runs them together and returns {name: result}."""
    if not jobs:
        return {}
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futures = {name: ex.submit(job[0], *job[1:]) for name, job in jobs.items()}
        return {name: f.result() for name, f in futures.items()}


# ---------- Memory helpers ----------

def get_rc(memory):
    rc = memory.setdefault("rc", {})
    rc.setdefault("maps", {})
    rc.setdefault("status", {})
    rc.setdefault("ledger", [])
    rc.setdefault("map_models", {})
    rc.setdefault("sessions", [])
    rc.setdefault("reviews", {})
    return rc


def short(model_name):
    return str(model_name or "").split("/")[-1]


def prompt_addon(memory):
    rc = get_rc(memory)
    open_items = [e for e in rc["ledger"] if not e.get("fixed") and e.get("text")]
    if not open_items:
        return ""
    items = "; ".join(f"{e['node']}: {e['text']}" for e in open_items[-5:])
    return "\nKnown unresolved misconceptions of this student: " + items + "."


# ---------- AI helpers ----------

def smart_ai(system_text, user_text, max_tokens=1500):
    """Try the stronger model first; fall back to the fast one."""
    try:
        text = core.ask_ai(system_text, user_text, model=core.PLAN_MODEL, max_tokens=max_tokens)
        if text:
            return text, core.PLAN_MODEL
    except Exception:
        pass
    return core.ask_ai(system_text, user_text, max_tokens=max_tokens), core.MODEL


def parse_json(text):
    text = (text or "").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON found in the reply")
    return json.loads(text[start:end + 1])


def clean_graph(data, root):
    items = data.get("nodes", [])
    if not items:
        raise ValueError("Empty map")
    first = str(items[0].get("name", "")).strip()

    def fix(name):
        name = str(name).strip()
        return root if name == first else name

    raw = {}
    for item in items:
        name = fix(item.get("name", ""))
        if not name:
            continue
        raw[name] = [fix(p) for p in item.get("prereqs", []) if str(p).strip()]
    raw.setdefault(root, [])

    order = []
    queue = [root]
    while queue and len(order) < 9:
        node = queue.pop(0)
        if node in order:
            continue
        order.append(node)
        for p in raw.get(node, []):
            raw.setdefault(p, [])
            queue.append(p)

    graph = {}
    for node in order:
        prereqs = []
        for p in raw.get(node, []):
            if p in order and p != node and p not in prereqs:
                prereqs.append(p)
        graph[node] = prereqs
    return graph


def build_map(target, level):
    prompt = (
        f"A {level} student struggles with the concept '{target}'.\n"
        "List the prerequisite concepts they must already understand, as a dependency tree "
        "2 to 3 levels deep, with at most 8 nodes in total including the target.\n"
        "Return ONLY valid JSON in exactly this shape, with no other text:\n"
        '{"nodes": [{"name": "<target concept>", "prereqs": ["<concept>", "<concept>"]}, '
        '{"name": "<concept>", "prereqs": []}]}\n'
        "Rules: the first node must be the target concept. Use short names (max 4 words). "
        "Every prerequisite must also appear as its own node. Foundational nodes have empty prereqs."
    )
    for _ in range(2):
        text, used = smart_ai("You output only valid JSON.", prompt, max_tokens=1500)
        try:
            graph = clean_graph(parse_json(text), target)
            if len(graph) >= 3:
                return graph, used
        except Exception:
            continue
    raise ValueError("Could not build a prerequisite map for that concept. Please try again.")


def make_probe(node, target, level, asked):
    if node == target:
        focus = f"can apply '{node}'"
    else:
        focus = f"truly understands '{node}' (a building block for '{target}')"
    return core.ask_ai(
        "You are a diagnostic tutor. Output only the question.",
        f"Write ONE short question for a {level} student that tests whether they {focus}. "
        "It must have one clear, short answer that can be typed in one line. "
        "Write any maths inside dollar signs, for example $x^2 + 3x$. "
        f"Do not repeat any of these questions: {asked}. "
        "Output only the question, with no answer and no hints.",
        max_tokens=400,
    )


def make_lesson(node, root, level, mis):
    text, _ = smart_ai(
        core.BASE_PROMPT,
        f"Teach '{node}' to a {level} student. It is a building block for '{root}'. "
        f"What we know about them: {mis or 'they are new to this idea'}. "
        "Write these parts, each with a short bold label: "
        "**The idea** (2 simple sentences), **Analogy** (one everyday comparison), "
        "**Worked example** (numbered steps), **Tips and tricks** (two memory tricks or shortcuts), "
        "**Common mistake** (one line). Keep it under 230 words. "
        "Write any maths inside dollar signs, for example $x^2$. Do not ask questions.",
        max_tokens=1300,
    )
    return text


def _lesson_text(node, root, level, mis):
    try:
        return make_lesson(node, root, level, mis)
    except Exception:
        return f"Let's learn **{node}** step by step. Tap \"Explain differently\" to try again."


def reveal_answer(question, node, answer, level):
    """The full solution: the answer, why it is right, and how to get it."""
    shown = answer if (answer.strip() and not is_idk(answer)) else "(the student said they don't know)"
    prompt = (
        f"Concept: {node}. Student level: {level}.\n"
        f"Question: {question}\nStudent's answer: {shown}\n\n"
        "Write the full solution in exactly this format:\n"
        "**Answer:** the correct answer, short and exact.\n"
        "**Why:** one or two sentences explaining the idea behind it.\n"
        "**How:** two to four numbered steps showing how to get there.\n"
        "If the student gave a wrong answer (not just \"I don't know\"), add one last line starting "
        "with **Your answer:** saying simply what went wrong. "
        "Double-check any arithmetic before writing it. "
        "Keep it under 140 words. Write maths inside dollar signs. Be kind and clear."
    )
    if REVEAL_STRONG:
        text, _ = smart_ai(core.BASE_PROMPT, prompt, max_tokens=900)
    else:
        text = core.ask_ai(core.BASE_PROMPT, prompt, max_tokens=900)
    return text


def _safe_reveal(question, node, answer, level, fallback=""):
    try:
        text = reveal_answer(question, node, answer, level)
        if text and text.strip():
            return text
    except Exception:
        pass
    return fallback or "Mentora couldn't write out the full answer just now. The lesson that follows covers it step by step."


def normalize_answer(text):
    """Rewrites common typed forms into standard notation, so the grader judges the maths, not the typing."""
    t = " ".join((text or "").split())
    t = t.replace("**", "^").replace("−", "-").replace("×", "*").replace("÷", "/").replace("√", " sqrt ")
    for sup, plain in (("²", "^2"), ("³", "^3"), ("⁴", "^4")):
        t = t.replace(sup, plain)
    t = re.sub(r"^(?:the\s+)?(?:answer|ans)\b\s*(?:is|:)?\s*", "", t, flags=re.I)
    t = re.sub(r"\bplus or minus\b|\+/-|\+-", "±", t, flags=re.I)
    t = re.sub(r"\bcube\s*root\s*(?:of\s*)?", "cbrt ", t, flags=re.I)
    t = re.sub(r"\bsquare\s*root\s*(?:of\s*)?", "sqrt ", t, flags=re.I)
    t = re.sub(r"\broot\s*(?:of\s*)?(?=[\d(])", "sqrt ", t, flags=re.I)
    t = re.sub(r"\bsquared\b", "^2", t, flags=re.I)
    t = re.sub(r"\bcubed\b", "^3", t, flags=re.I)
    t = re.sub(r"\bto the power(?: of)?\s*(\d+)", r"^\1", t, flags=re.I)
    t = re.sub(r"\bmultiplied by\b|\btimes\b", "*", t, flags=re.I)
    t = re.sub(r"\bdivided by\b", "/", t, flags=re.I)
    t = re.sub(r"\bpi\b", "π", t, flags=re.I)
    t = re.sub(r"\s*\^\s*", "^", t)
    return t.strip()


def _second_opinion(question, answer, node):
    text, _ = smart_ai(
        "You are a careful maths and science checker.",
        f"Concept: {node}\nQuestion: {question}\nStudent answer: {answer}\n\n"
        "Work out the correct answer yourself first. Then decide whether the student's answer is equivalent to it. "
        "Ignore formatting and notation (x squared = x^2, sqrt(16) = square root of 16), the order of terms or "
        "solutions, and tiny rounding differences. An answer that is only partly right, or that does not attempt "
        "the question, is NO.\n"
        "End with exactly one line: FINAL: YES or FINAL: NO",
        max_tokens=800,
    )
    return bool(re.search(r"FINAL:\s*\**\s*YES", text, re.I))


def grade_probe(question, answer, node):
    clean = normalize_answer(answer)
    reply = core.ask_ai(
        "You are a strict but fair diagnostic tutor.",
        f"Concept being tested: {node}\nQuestion: {question}\n"
        f"Student answer: {clean if clean else '(no answer)'}\n\n"
        "Method: first work out the correct answer yourself, then compare it with the student's answer. "
        "Judge the maths, not the typing: accept any equivalent form (x squared = x^2, "
        "sqrt(16) = square root of 16 = 4, 1/2 = 0.5, a different order of terms or solutions, extra spaces). "
        "If the student made no real attempt, or the answer is unrelated or not actually correct, "
        "the verdict is WRONG.\n"
        "Reply in exactly this format, on four lines:\n"
        "SOLUTION: the correct answer you worked out, very short\n"
        "VERDICT: CORRECT or WRONG\n"
        "MISCONCEPTION: one short sentence naming the specific wrong idea, or NONE if correct\n"
        "EXPLAIN: one or two sentences with the right answer. Write maths inside dollar signs.",
        max_tokens=700,
    )
    verdict = re.search(r"VERDICT:\s*\**\s*(CORRECT|WRONG)", reply, re.I)
    mis = re.search(r"MISCONCEPTION:\s*(.+)", reply, re.I)
    exp = re.search(r"EXPLAIN:\s*(.+)", reply, re.I | re.S)
    sol = re.search(r"SOLUTION:\s*(.+)", reply, re.I)
    correct = bool(verdict) and verdict.group(1).upper() == "CORRECT"
    misconception = mis.group(1).strip() if mis else ""
    if misconception.upper().startswith("NONE"):
        misconception = ""
    explain = exp.group(1).strip() if exp else ""
    if correct and re.search(r"no (real )?attempt|did not (answer|attempt|provide)|didn't (answer|attempt)|not an answer|no answer", explain, re.I):
        correct = False      # the AI contradicted itself: treat as wrong
    if not correct and clean:
        try:                 # a second opinion from the stronger model before marking a real attempt wrong
            if _second_opinion(question, clean, node):
                correct = True
                misconception = ""
                explain = f"That's right. The answer is {sol.group(1).strip()}." if sol else "That's right."
        except Exception:
            pass
    _log(question, answer, node, reply, correct)
    return correct, misconception, explain


def node_levels(graph):
    level = {n: 0 for n in graph}
    for _ in range(len(graph)):
        changed = False
        for n, prereqs in graph.items():
            for p in prereqs:
                if p in level and level[p] < level[n] + 1 <= len(graph):
                    level[p] = level[n] + 1
                    changed = True
        if not changed:
            break
    return level


# ---------- Thread helpers ----------

def _say(kind, text, **extra):
    RUN["thread"].append({"role": "mentora", "kind": kind, "text": text, **extra})


def _user(text):
    RUN["thread"].append({"role": "user", "kind": "answer", "text": text or "I don't know"})


def _mark_fixed(rc, target, node):
    for e in rc["ledger"]:
        if e["target"] == target and e["node"] == node:
            e["fixed"] = True


def _safe_lesson(node):
    return _lesson_text(node, RUN["root"], RUN["level"], RUN["mis"].get(node, ""))


# ---------- Daily review (spaced re-checks of fixed gaps) ----------

def due_reviews(memory):
    rc = get_rc(memory)
    today = str(date.today())
    items = [v for v in rc["reviews"].values() if not v.get("done") and v.get("due") and v["due"] <= today]
    items.sort(key=lambda v: (v["due"], v["stage"]))
    return items


def _schedule_review(rc, key, target, node, level):
    rid = f"{key}|{node}"
    rc["reviews"][rid] = {
        "id": rid, "key": key, "target": target, "node": node, "level": level, "stage": 0,
        "due": str(date.today() + timedelta(days=INTERVALS[0])),
        "fixed_on": str(date.today()), "history": [], "done": False,
    }


def _record_review(rc, item, correct):
    rv = rc["reviews"].get(item["id"])
    if rv is None:
        return
    today = date.today()
    rv["history"].append({"date": str(today), "ok": bool(correct)})
    if correct:
        rv["stage"] += 1
        if rv["stage"] >= len(INTERVALS):
            rv["done"] = True            # remembered for the long term: retire it
            rv["due"] = None
        else:
            rv["due"] = str(today + timedelta(days=INTERVALS[rv["stage"]]))
    else:
        rv["stage"] = 0
        rv["due"] = str(today + timedelta(days=1))
        status = rc["status"].setdefault(item["key"], {})
        if item["key"] in rc["maps"] and item["node"] in rc["maps"][item["key"]]:
            status[item["node"]] = "gap"       # forgotten: the node turns red again
        for e in rc["ledger"]:
            if e["target"] == rv["target"] and e["node"] == item["node"]:
                e["fixed"] = False


def start_review(memory):
    due = due_reviews(memory)[:5]
    if not due:
        raise ValueError("Nothing is due for review right now. Come back tomorrow!")
    items = [
        {"id": v["id"], "key": v["key"], "target": v["target"], "node": v["node"], "level": v["level"]}
        for v in due
    ]
    first = items[0]
    q = make_probe(first["node"], first["target"], first["level"], [])
    RUN.clear()
    RUN.update({
        "stage": "review", "key": first["key"], "root": "Daily review", "level": first["level"],
        "items": items, "ridx": 0, "review_ok": 0, "scan": [], "idx": 0, "plan": [], "step": 0,
        "passed": [], "skipped": [], "asked": [q], "mis": {}, "current": first["node"], "question": q,
        "attempts": 0, "outcome": None, "report": "", "report_model": "", "date": str(date.today()),
        "session_id": str(int(time.time() * 1000)), "thread": [],
    })
    n = len(items)
    _say("intro", f"Daily review: {n} {'gap' if n == 1 else 'gaps'} you fixed earlier. Let's see whether "
         "they stuck. Same rules as before: \"I don't know\" is fine, and I'll show the answer.")
    _say("question", q, node=first["node"], n=1, total=n)
    _commit(memory)
    return view(memory)


def _submit_review(memory, rc, node, answer, correct, mis, exp, idk):
    item = RUN["items"][RUN["ridx"]]
    nxt = RUN["ridx"] + 1
    jobs = {}
    if nxt < len(RUN["items"]):
        n_item = RUN["items"][nxt]
        jobs["next"] = (make_probe, n_item["node"], n_item["target"], n_item["level"], list(RUN["asked"]))
    if not correct:
        jobs["reveal"] = (_safe_reveal, RUN["question"], node, answer, item["level"], exp)
    res = _parallel(jobs)      # AI calls first, so a failure leaves the state untouched

    _user(answer)
    _record_review(rc, item, correct)
    if correct:
        RUN["review_ok"] += 1
        _say("feedback", exp or "Correct. It stuck!", ok=True, node=node)
    else:
        _say("feedback", res["reveal"], ok=False, node=node, mis="" if idk else mis, idk=idk)
        _say("note", f"**{node}** slipped. I've put it back on your map, and I'll check it again tomorrow.")
    RUN["ridx"] = nxt
    RUN["idx"] = nxt
    if nxt < len(RUN["items"]):
        n_item = RUN["items"][nxt]
        RUN["key"] = n_item["key"]
        RUN["level"] = n_item["level"]
        RUN["current"] = n_item["node"]
        RUN["question"] = res["next"]
        RUN["asked"].append(res["next"])
        _say("question", res["next"], node=n_item["node"], n=nxt + 1, total=len(RUN["items"]))
    else:
        n = len(RUN["items"])
        ok = RUN["review_ok"]
        RUN["stage"] = "done"
        RUN["current"] = None
        if ok == n:
            RUN["outcome"] = "fixed"
            _say("result", f"All {n} stuck. I'll check them again in a few days.", tone="ok")
        else:
            RUN["outcome"] = "partial"
            _say("result", f"{ok} of {n} stuck. {n - ok} came back onto your map and will return tomorrow.", tone="warn")


def fast_forward(memory):
    """Demo tool: makes every scheduled review due right now."""
    rc = get_rc(memory)
    today = str(date.today())
    for v in rc["reviews"].values():
        if not v.get("done"):
            v["due"] = today
    core.save_memory(memory)
    return view(memory)


# ---------- Sessions ----------

def _save_session(memory):
    rc = get_rc(memory)
    sid = RUN.get("session_id")
    if not sid:
        return
    rec = {
        "id": sid, "key": RUN["key"], "concept": RUN["root"], "level": RUN["level"],
        "date": RUN["date"], "outcome": RUN.get("outcome"),
        "status": dict(rc["status"].get(RUN["key"], {})),
        "run": json.loads(json.dumps(dict(RUN))),
    }
    sessions = rc["sessions"]
    for i, s in enumerate(sessions):
        if s["id"] == sid:
            sessions[i] = rec
            break
    else:
        sessions.append(rec)
        del sessions[:-8]


def _commit(memory):
    _save_session(memory)
    core.save_memory(memory)


def list_sessions(memory):
    rc = get_rc(memory)
    out = []
    for s in reversed(rc["sessions"]):
        out.append({
            "id": s["id"], "concept": s["concept"], "date": s["date"],
            "outcome": s.get("outcome"), "active": s["id"] == RUN.get("session_id"),
        })
    return out


def get_session(memory, sid):
    rc = get_rc(memory)
    for s in rc["sessions"]:
        if s["id"] == sid:
            run = s["run"]
            v = _build_view(rc, run, status=s.get("status", {}), viewing=True)
            v["resumable"] = run.get("stage") not in ("done", "idle", None)
            return v
    raise ValueError("That session no longer exists.")


def resume(memory, sid):
    rc = get_rc(memory)
    for s in rc["sessions"]:
        if s["id"] == sid:
            RUN.clear()
            RUN.update(json.loads(json.dumps(s["run"])))
            rc["status"][RUN["key"]] = dict(s.get("status", {}))
            core.save_memory(memory)
            return view(memory)
    raise ValueError("That session no longer exists.")


# ---------- The diagnostic run ----------

def reset():
    RUN.clear()
    RUN["stage"] = "idle"


def start(memory, concept, level):
    rc = get_rc(memory)
    key = concept.lower()
    if key not in rc["maps"]:
        graph, used = build_map(concept, level)
        rc["maps"][key] = graph
        rc["map_models"][key] = used
    graph = rc["maps"][key]
    root = list(graph)[0]
    lv = node_levels(graph)
    order = list(graph)
    scan = sorted(order, key=lambda n: (-lv[n], order.index(n)))
    first_q = make_probe(scan[0], root, level, [])

    rc["status"][key] = {n: "unknown" for n in graph}
    RUN.clear()
    RUN.update({
        "stage": "scan", "key": key, "root": root, "level": level, "scan": scan, "idx": 0,
        "plan": [], "step": 0, "passed": [], "skipped": [], "asked": [first_q], "mis": {},
        "current": scan[0], "question": first_q, "attempts": 0, "outcome": None,
        "report": "", "report_model": "", "date": str(date.today()),
        "session_id": str(int(time.time() * 1000)), "thread": [],
    })
    _say(
        "intro",
        f"Let's find out exactly what's missing for **{root}**. I mapped {len(scan)} building blocks "
        "and I'll check each one, starting with the basics. Answer honestly: "
        "\"I don't know\" is a perfectly good answer, and I'll show you the full answer every time. "
        "I'm an AI, so double-check anything important with your teacher.",
    )
    _say("question", first_q, node=scan[0], n=1, total=len(scan))
    _commit(memory)
    return view(memory)


def submit(memory, answer):
    stage = RUN.get("stage")
    if stage not in ("scan", "check", "review"):
        raise ValueError("There is nothing to answer right now.")
    rc = get_rc(memory)
    key = RUN["key"]
    status = rc["status"].setdefault(key, {})
    answer = (answer or "").strip()
    node = RUN["current"]

    idk = is_idk(answer)
    if idk:
        _log(RUN.get("question", ""), answer, node, "(treated as I don't know)", False)
        correct = False
        mis = "Hasn't met this idea yet (answered \"I don't know\")."
        exp = ""
    else:
        correct, mis, exp = grade_probe(RUN["question"], answer, node)

    if stage == "scan":
        _submit_scan(memory, rc, status, node, answer, correct, mis, exp, idk)
    elif stage == "check":
        _submit_check(memory, rc, status, node, answer, correct, mis, exp, idk)
    else:
        _submit_review(memory, rc, node, answer, correct, mis, exp, idk)
    _commit(memory)
    return view(memory)


def _submit_scan(memory, rc, status, node, answer, correct, mis, exp, idk):
    nxt = RUN["idx"] + 1
    jobs = {}
    if nxt < len(RUN["scan"]):
        jobs["next"] = (make_probe, RUN["scan"][nxt], RUN["root"], RUN["level"], list(RUN["asked"]))
    if not correct:
        jobs["reveal"] = (_safe_reveal, RUN["question"], node, answer, RUN["level"], exp)
    res = _parallel(jobs)      # AI calls first, so a failure leaves the state untouched
    nxt_q = res.get("next")

    _user(answer)
    status[node] = "mastered" if correct else "gap"
    if correct:
        _say("feedback", exp or "Correct.", ok=True, node=node)
    else:
        RUN["mis"][node] = mis
        _say("feedback", res["reveal"], ok=False, node=node, mis="" if idk else mis, idk=idk)
    RUN["idx"] = nxt
    if nxt_q is not None:
        RUN["current"] = RUN["scan"][nxt]
        RUN["question"] = nxt_q
        RUN["asked"].append(nxt_q)
        _say("question", nxt_q, node=RUN["current"], n=nxt + 1, total=len(RUN["scan"]))
    else:
        _finish_scan(memory, rc, status)


def _finish_scan(memory, rc, status):
    key = RUN["key"]
    gaps = [n for n in RUN["scan"] if status.get(n) == "gap"]

    if not gaps:
        RUN["stage"] = "done"
        RUN["outcome"] = "no_gap"
        RUN["current"] = None
        _say("result", f"Great news: you already understand all {len(RUN['scan'])} building blocks "
             f"of **{RUN['root']}**. Try a harder concept next.", tone="ok")
        core.apply_result(memory, key, True)
        return

    RUN["plan"] = gaps
    today = str(date.today())
    for n in gaps:
        rc["ledger"].append(
            {"target": RUN["root"], "node": n, "text": RUN["mis"].get(n, ""), "date": today, "fixed": False}
        )
    core.apply_result(memory, key, False)

    chain = [
        {"concept": n, "understood": status.get(n) == "mastered", "misconception": RUN["mis"].get(n, "")}
        for n in RUN["scan"]
    ]
    try:
        report, used = smart_ai(
            core.BASE_PROMPT,
            f"A {RUN['level']} student wants to master '{RUN['root']}'. We tested every building block, "
            f"foundations first. Results: {chain}. Write a short Root-Cause Report (max 80 words, no headings): "
            "the deepest root gap, why it blocks the main concept, and the key misconception. "
            "Be kind and direct. Write maths inside dollar signs.",
            max_tokens=700,
        )
    except Exception:
        report = f"Your gaps are in: {', '.join(gaps)}. We'll fix them from the foundations up."
        used = core.MODEL
    RUN["report"] = report
    RUN["report_model"] = used
    _say("report", report, model=short(used))

    lines = "\n".join(
        f"{i + 1}. **{n}**" + (f": {RUN['mis'][n]}" if RUN["mis"].get(n) else "")
        for i, n in enumerate(gaps)
    )
    _say("plan", f"Scan complete. Here is your learning path, from the foundations up:\n{lines}\n\n"
         "Now I'll teach each topic with an example and tricks, then check it with a few questions.")
    _enter_step(0, _safe_lesson(gaps[0]))


def _enter_step(step, lesson):
    node = RUN["plan"][step]
    RUN["step"] = step
    RUN["current"] = node
    RUN["stage"] = "lesson"
    RUN["attempts"] = 0
    _say("lesson", lesson, node=node, step=step + 1, total=len(RUN["plan"]))


def _submit_check(memory, rc, status, node, answer, correct, mis, exp, idk):
    plan = RUN["plan"]
    nxt_step = RUN["step"] + 1
    advancing = correct or RUN["attempts"] + 1 >= 3
    jobs = {}
    if not correct:
        jobs["reveal"] = (_safe_reveal, RUN["question"], node, answer, RUN["level"], exp)
    if advancing:
        if nxt_step < len(plan):
            nxt_node = plan[nxt_step]
            jobs["lesson"] = (_lesson_text, nxt_node, RUN["root"], RUN["level"], RUN["mis"].get(nxt_node, ""))
    else:
        jobs["next"] = (make_probe, node, RUN["root"], RUN["level"], list(RUN["asked"]))
    res = _parallel(jobs)      # AI calls first, so a failure leaves the state untouched

    _user(answer)
    if correct:
        status[node] = "mastered"
        RUN["passed"].append(node)
        _mark_fixed(rc, RUN["root"], node)
        _schedule_review(rc, RUN["key"], RUN["root"], node, RUN["level"])
        _say("feedback", exp or "Correct!", ok=True, node=node); _say("note", f"📅 Fixed. I'll check **{node}** again tomorrow to make sure it sticks.")
    else:
        RUN["attempts"] += 1
        _say("feedback", res["reveal"], ok=False, node=node, mis="" if idk else mis, idk=idk)
        if not advancing:
            new_q = res["next"]
            RUN["question"] = new_q
            RUN["asked"].append(new_q)
            _say("question", new_q, node=node, check=True, attempt=RUN["attempts"] + 1)
            return
        RUN["skipped"].append(node)
        _say("note", f"We'll leave **{node}** for now. It needs more practice. Let's move on.")

    if nxt_step < len(plan):
        _enter_step(nxt_step, res["lesson"])
    else:
        _finish_all(memory, status)


def _finish_all(memory, status):
    key = RUN["key"]
    RUN["stage"] = "done"
    RUN["current"] = None
    root_ok = status.get(RUN["root"]) == "mastered"
    if root_ok and not RUN["skipped"]:
        RUN["outcome"] = "fixed"
        core.apply_result(memory, key, True)
        _say("result", f"You fixed the root cause and mastered **{RUN['root']}**. "
             "Look at your map: it's turning green. I'll check that it sticks with a Daily Review.", tone="ok")
    elif RUN["passed"]:
        RUN["outcome"] = "partial"
        left = ", ".join(RUN["skipped"]) or RUN["root"]
        _say("result", f"Good progress: you mastered {len(RUN['passed'])} of {len(RUN['plan'])} steps. "
             f"Still needs practice: {left}. Diagnose again after some practice.", tone="warn")
    else:
        RUN["outcome"] = "unresolved"
        _say("result", "These topics need more time. Try the lessons again, or ask the Chat coach "
             "to explain them another way, then run a new diagnosis.", tone="bad")


def advance(memory, action="ready"):
    if RUN.get("stage") != "lesson":
        raise ValueError("Nothing to continue right now.")
    node = RUN["current"]
    if action == "reteach":
        text, _ = smart_ai(
            core.BASE_PROMPT,
            f"A student did not understand your lesson on '{node}' (a building block for "
            f"'{RUN['root']}', level: {RUN['level']}). Explain it again in a completely different way: "
            "simpler words, a new analogy, a new example, plus one trick to remember it. "
            "Under 170 words. Write maths inside dollar signs.",
            max_tokens=1000,
        )
        _say("lesson", text, node=node, retry=True)
    else:
        q = make_probe(node, RUN["root"], RUN["level"], RUN["asked"])
        RUN["question"] = q
        RUN["asked"].append(q)
        RUN["stage"] = "check"
        RUN["attempts"] = 0
        _say("question", q, node=node, check=True, attempt=1)
    _commit(memory)
    return view(memory)


# ---------- What the page receives ----------

def _graph_view(rc, key, current=None, status=None):
    if not key or key not in rc["maps"]:
        return None
    graph = rc["maps"][key]
    status = status if status is not None else rc["status"].get(key, {})
    nodes = [{"id": n, "status": "probing" if n == current else status.get(n, "unknown")} for n in graph]
    edges = [{"from": p, "to": n} for n, prereqs in graph.items() for p in prereqs]
    return {
        "key": key, "root": list(graph)[0], "nodes": nodes, "edges": edges,
        "model": short(rc["map_models"].get(key, "")),
    }


def _progress(run):
    stage = run.get("stage", "idle")
    if stage == "idle":
        return None
    if stage == "review":
        return {"phase": "review", "scan_done": run.get("ridx", 0),
                "scan_total": len(run.get("items", [])), "plan": []}
    if run.get("items") is not None and stage == "done":
        return None
    passed, skipped = run.get("passed", []), run.get("skipped", [])
    step = run.get("step", 0)
    items = []
    for i, n in enumerate(run.get("plan", [])):
        if n in passed:
            s = "done"
        elif n in skipped:
            s = "skipped"
        elif i == step and stage in ("lesson", "check"):
            s = "current"
        else:
            s = "todo"
        items.append({"node": n, "status": s})
    phase = "scan" if stage == "scan" else ("done" if stage == "done" else "learn")
    return {
        "phase": phase, "scan_done": run.get("idx", 0),
        "scan_total": len(run.get("scan", [])), "plan": items,
    }


def _build_view(rc, run, status=None, viewing=False):
    key = run.get("key")
    if not key or key not in rc["maps"]:
        key = list(rc["maps"])[-1] if rc["maps"] else None
    stage = run.get("stage", "idle")
    current = run.get("current") if stage in ("scan", "lesson", "check", "review") else None
    return {
        "stage": stage, "root": run.get("root"), "level": run.get("level"), "date": run.get("date"),
        "thread": run.get("thread", []), "progress": _progress(run), "outcome": run.get("outcome"),
        "graph": _graph_view(rc, key, current, status), "viewing": viewing,
        "session_id": run.get("session_id"),
    }


def view(memory):
    return _build_view(get_rc(memory), RUN)


def app_state(memory):
    rc = get_rc(memory)
    concepts = []
    for key, graph in rc["maps"].items():
        st = rc["status"].get(key, {})
        total = len(graph)
        mastered = sum(1 for n in graph if st.get(n) == "mastered")
        concepts.append({
            "name": list(graph)[0], "mastered": mastered, "total": total,
            "pct": round(100 * mastered / total) if total else 0,
        })
    active = [v for v in rc["reviews"].values() if not v.get("done")]
    active.sort(key=lambda v: (v.get("due") or "9999", v["stage"]))
    return {
        "model": short(core.MODEL),
        "plan_model": short(core.PLAN_MODEL),
        "stats": {
            "concepts": len(rc["maps"]),
            "repaired": sum(1 for e in rc["ledger"] if e.get("fixed")),
            "open": sum(1 for e in rc["ledger"] if not e.get("fixed")),
            "weak": len(memory["weak_topics"]),
        },
        "concepts": concepts,
        "ledger": rc["ledger"][-30:],
        "notes": memory["notes"],
        "exam": memory.get("exam"),
        "exam_days": core.exam_days_left(memory),
        "reviews": {
            "due": len(due_reviews(memory)),
            "total": len(active),
            "items": [
                {"node": v["node"], "target": v["target"], "due": v["due"], "stage": v["stage"]}
                for v in active[:12]
            ],
        },
    }
def load_sample(memory):
    """Demo tool: adds a ready-made example (no AI calls) so Daily Review can be tried straight away."""
    rc = get_rc(memory)
    key = "solving quadratic equations"
    root = "Solving quadratic equations"
    level = "School (grades 6-10)"
    today = str(date.today())
    rc["maps"][key] = {
        root: ["Factoring quadratics", "Quadratic formula"],
        "Factoring quadratics": ["Multiplying binomials", "Greatest common factor"],
        "Quadratic formula": ["Square roots", "Order of operations"],
        "Multiplying binomials": [],
        "Greatest common factor": [],
        "Square roots": [],
        "Order of operations": [],
    }
    rc["map_models"][key] = "sample data"
    rc["status"][key] = {
        root: "gap", "Factoring quadratics": "gap", "Quadratic formula": "mastered",
        "Multiplying binomials": "mastered", "Greatest common factor": "mastered",
        "Square roots": "mastered", "Order of operations": "mastered",
    }
    fixed_nodes = [
        ("Multiplying binomials", "Forgot to combine like terms after multiplying."),
        ("Greatest common factor", "Listed some factors but missed the largest shared one."),
    ]
    for node, text in fixed_nodes:
        rid = f"{key}|{node}"
        if rid not in rc["reviews"]:
            _schedule_review(rc, key, root, node, level)
            rc["ledger"].append({"target": root, "node": node, "text": text, "date": today, "fixed": True})
        rc["reviews"][rid]["due"] = today
        rc["reviews"][rid]["done"] = False
    core.save_memory(memory)
    return view(memory)