import os
import json
from datetime import date
from dotenv import load_dotenv
from openai import OpenAI

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

client = OpenAI(
    base_url="https://api.tokenfactory.nebius.com/v1/",
    api_key=os.environ.get("NEBIUS_API_KEY"),
    timeout=60,
)

MODEL = "nvidia/Nemotron-3_5-Lightning"            # fast model for chat and quizzes
PLAN_MODEL = "nvidia/nemotron-3-super-120b-a12b"   # stronger model for study plans
MEMORY_FILE = os.path.join(BASE_DIR, "memory.json")

BASE_PROMPT = (
    "You are Mentora, a friendly study coach for students. "
    "Explain things simply and keep answers brief. "
    "Reply with only the final answer. "
    "Do not describe your reasoning or your instructions."
)


# ---------- Memory ----------

def load_memory():
    if os.path.exists(MEMORY_FILE):
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            memory = json.load(f)
    else:
        memory = {}
    memory.setdefault("weak_topics", {})
    memory.setdefault("notes", [])
    memory.setdefault("scores", [])
    memory.setdefault("exam", None)
    return memory


def save_memory(memory):
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(memory, f, indent=2)


def clear_memory(memory):
    memory.clear()
    memory.update({"weak_topics": {}, "notes": [], "scores": [], "exam": None})
    save_memory(memory)


def exam_days_left(memory):
    exam = memory.get("exam")
    if not exam:
        return None
    try:
        return (date.fromisoformat(exam["date"]) - date.today()).days
    except Exception:
        return None


def build_system_prompt(memory):
    prompt = BASE_PROMPT
    if memory["weak_topics"]:
        topics = ", ".join(f"{t} ({n} mistakes)" for t, n in memory["weak_topics"].items())
        prompt += "\nTopics this student finds difficult: " + topics + "."
    if memory["notes"]:
        prompt += "\nThings to remember about this student: " + "; ".join(memory["notes"]) + "."
    days = exam_days_left(memory)
    if days is not None and days >= 0:
        prompt += f"\nThe student has an exam on {memory['exam']['subject']} in {days} days."
    prompt += "\nUse this information to personalise your help."
    return prompt


# ---------- Talking to the AI ----------

def call_ai(messages, model=None, thinking=False, max_tokens=1500):
    response = client.chat.completions.create(
        model=model or MODEL,
        max_tokens=max_tokens,
        messages=messages,
        extra_body={"chat_template_kwargs": {"enable_thinking": thinking}},
    )
    return (response.choices[0].message.content or "").strip()


def stream_ai(messages, model=None, max_tokens=1500):
    """Yields the reply piece by piece so the page can type it out live."""
    stream = client.chat.completions.create(
        model=model or MODEL,
        max_tokens=max_tokens,
        messages=messages,
        stream=True,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


def ask_ai(system_text, user_text, model=None, max_tokens=1500):
    return call_ai(
        [
            {"role": "system", "content": system_text},
            {"role": "user", "content": user_text},
        ],
        model=model,
        max_tokens=max_tokens,
    )


# ---------- Skills ----------

def summarize(text):
    return ask_ai(
        BASE_PROMPT,
        "Summarize these notes in 5 short bullet points, "
        "then list 3 key terms with one-line meanings:\n\n" + text[:12000],
    )


def make_plan(memory):
    exam_part = ""
    days = exam_days_left(memory)
    if days is not None and days >= 0:
        exam_part = (
            f"The student has an exam on {memory['exam']['subject']} in {days} days, "
            "so fit the plan to that deadline. "
        )
    prompt = (
        "Create a simple 5-day revision plan for this student. "
        f"Weak topics with mistake counts: {memory['weak_topics']}. "
        f"Recent quiz scores: {memory['scores'][-5:]}. "
        f"Notes about the student: {memory['notes']}. "
        + exam_part +
        "Put the weakest topics first. For each day give a topic, "
        "one activity and a time estimate. Keep it short."
    )
    try:
        return ask_ai(BASE_PROMPT, prompt, model=PLAN_MODEL, max_tokens=2000), PLAN_MODEL
    except Exception:
        return ask_ai(BASE_PROMPT, prompt, max_tokens=2000), MODEL


def generate_question(topic, asked, notes_text=None):
    notes_part = f"\nBase it only on these notes:\n{notes_text[:12000]}\n" if notes_text else ""
    return ask_ai(
        "You are a quiz master.",
        f"Write ONE short quiz question about {topic} for a student. "
        f"Do not repeat any of these questions: {asked}. "
        "Output only the question, with no answer." + notes_part,
    )


def grade_answer(question, answer, notes_text=None):
    notes_part = f"\nUse these notes as the source of truth:\n{notes_text[:12000]}\n" if notes_text else ""
    reply = ask_ai(
        "You are a fair, friendly teacher grading a quiz.",
        f"Question: {question}\nStudent answer: {answer}\n"
        "Start your reply with exactly one word: CORRECT or WRONG. "
        "Then explain in at most 2 sentences, and give the right answer if it was wrong."
        + notes_part,
    )
    parts = reply.split(None, 1)
    verdict = parts[0].upper().strip(".:,!*") if parts else ""
    feedback = parts[1] if len(parts) > 1 else ""
    return verdict == "CORRECT", feedback


def apply_result(memory, topic, correct):
    if correct:
        if topic in memory["weak_topics"]:
            memory["weak_topics"][topic] -= 1
            if memory["weak_topics"][topic] <= 0:
                del memory["weak_topics"][topic]
    else:
        memory["weak_topics"][topic] = memory["weak_topics"].get(topic, 0) + 1


def record_score(memory, topic, score, rounds):
    memory["scores"].append(
        {"topic": topic, "score": score, "out_of": rounds, "date": str(date.today())}
    )
    save_memory(memory)