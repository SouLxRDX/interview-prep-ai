from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel, field_validator
from dataclasses import dataclass
from dotenv import load_dotenv
from groq import Groq
from google import genai
from pypdf import PdfReader
import os, uuid, json, sqlite3, io, logging, re, asyncio, time
import queue as thread_queue
from datetime import datetime, timedelta, timezone

# --------------------------------------------------
# Config & Logging
# --------------------------------------------------

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("InterviewAI")

# --------------------------------------------------
# Constants
# --------------------------------------------------

VALID_DIFFICULTIES = {"Junior", "Mid", "Senior", "Staff"}
MAX_RESUME_BYTES = 5 * 1024 * 1024
MAX_QUESTIONS = 10
HISTORY_CONTEXT_WINDOW = 20
SESSION_TTL = timedelta(minutes=60)
CLEANUP_INTERVAL_SEC = 300
MEMORY_UPDATE_EVERY = 2  # update memory every N user answers

# Always save DB next to main.py regardless of working directory
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "interviews.db")


def _default_memory() -> dict:
    """Fresh semantic memory structure for a new interview."""
    return {
        "topics_covered": [],
        "strengths_seen": [],
        "weak_signals": [],
        "confidence_level": "unknown",      # low / medium / high / unknown
        "communication_notes": "",
        "effective_difficulty": "as_selected", # easier / as_selected / harder
        "adaptation_reason": "",
    }


def update_memory(current_memory: dict, recent_history: list[dict], role: str, difficulty: str) -> dict:
    """Use AI to analyze recent exchanges and update semantic memory."""
    prompt = f"""You are an interview analysis system. Analyze the recent interview exchanges for a {difficulty}-level {role} position.

Current memory state:
{json.dumps(current_memory, indent=2)}

Based on the conversation, return ONLY valid JSON updating the memory:

{{
  "topics_covered": ["topic1", "topic2"],
  "strengths_seen": ["specific strength observed"],
  "weak_signals": ["specific weakness or gap observed"],
  "confidence_level": "low|medium|high",
  "communication_notes": "1 sentence on how clearly they communicate",
  "effective_difficulty": "easier|as_selected|harder",
  "adaptation_reason": "why you recommend this difficulty shift"
}}

RULES:
- MERGE new observations with existing ones (don't discard previous entries)
- topics_covered: cumulative list of technical topics discussed so far
- strengths_seen: specific things the candidate did well (max 5, replace weakest)
- weak_signals: gaps, vague answers, mistakes (max 5, replace oldest)
- confidence_level: based on answer depth, specificity, and certainty
- effective_difficulty: recommend "easier" if struggling, "harder" if excelling, "as_selected" if appropriate
- adaptation_reason: brief explanation for difficulty recommendation
- Be honest and specific. No generic praise.
"""
    result = call_ai(
        [{"role": "system", "content": prompt}] + recent_history[-6:],
        max_tokens=350,
        temperature=0.2,
    )
    parsed = parse_json_from_ai(result.content)
    if parsed:
        # Merge: keep cumulative lists, cap lengths
        merged = dict(current_memory)
        for key in ["topics_covered", "strengths_seen", "weak_signals"]:
            existing = set(merged.get(key, []))
            existing.update(parsed.get(key, []))
            merged[key] = list(existing)[-8:]  # cap at 8 items
        for key in ["confidence_level", "communication_notes", "effective_difficulty", "adaptation_reason"]:
            if parsed.get(key):
                merged[key] = parsed[key]
        logger.info(f"Memory updated via {result.provider} — confidence={merged.get('confidence_level')}, adapt={merged.get('effective_difficulty')}")
        return merged
    logger.warning("Memory update parse failed, keeping existing memory")
    return current_memory

# --------------------------------------------------
# AI Clients & Structured Response
# --------------------------------------------------

# ── Multi-key pools (comma-separated in .env) ──

GROQ_KEYS = [k.strip() for k in os.getenv("GROQ_API_KEYS", "").split(",") if k.strip()]
GEMINI_KEYS = [k.strip() for k in os.getenv("GEMINI_API_KEYS", "").split(",") if k.strip()]
OPENROUTER_KEYS = [k.strip() for k in os.getenv("OPENROUTER_API_KEYS", "").split(",") if k.strip()]

groq_clients = [
    {"client": Groq(api_key=key), "cooldown_until": None}
    for key in GROQ_KEYS
]
gemini_clients = [
    {"client": genai.Client(api_key=key), "cooldown_until": None}
    for key in GEMINI_KEYS
]
openrouter_clients = [
    {"key": key, "cooldown_until": None}
    for key in OPENROUTER_KEYS
]

logger.info(f"Loaded {len(groq_clients)} Groq key(s), {len(gemini_clients)} Gemini key(s), {len(openrouter_clients)} OpenRouter key(s)")


@dataclass(frozen=True)
class AIResult:
    """Structured return from call_ai — provides observability metadata."""
    content: str
    provider: str       # "groq" | "gemini" | "none"
    latency_ms: float
    fallback_used: bool


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_available(entry: dict) -> bool:
    """Check if a key is past its cooldown period."""
    cooldown = entry["cooldown_until"]
    if cooldown is None:
        return True
    return datetime.now(timezone.utc) > cooldown


def call_ai(messages: list, max_tokens: int = 250, temperature: float = 0.75) -> AIResult:
    """
    Multi-key rotation with cooldown.
    Tries all Groq keys → all Gemini keys → graceful failure.
    Rate-limited keys (429) get a 5-minute cooldown.
    """
    start = time.monotonic()

    # ── Primary: Groq pool ──
    for entry in groq_clients:
        if not _client_available(entry):
            continue

        try:
            res = entry["client"].chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            elapsed = (time.monotonic() - start) * 1000
            logger.info(f"Groq responded in {elapsed:.0f}ms")
            return AIResult(
                content=res.choices[0].message.content,
                provider="groq",
                latency_ms=elapsed,
                fallback_used=False,
            )
        except Exception as e:
            logger.warning(f"Groq key failed: {str(e)[:80]}")
            if "429" in str(e):
                entry["cooldown_until"] = datetime.now(timezone.utc) + timedelta(minutes=5)
            continue

    # ── Fallback: Gemini pool ──
    for entry in gemini_clients:
        if not _client_available(entry):
            continue

        try:
            system_text = next(
                (m["content"] for m in messages if m["role"] == "system"), ""
            )
            convo = [
                {
                    "role": "user" if m["role"] == "user" else "model",
                    "parts": [{"text": m["content"]}],
                }
                for m in messages if m["role"] != "system"
            ]
            res = entry["client"].models.generate_content(
                model="gemini-2.0-flash",
                contents=convo,
                config={
                    "system_instruction": system_text,
                    "max_output_tokens": max_tokens,
                },
            )
            elapsed = (time.monotonic() - start) * 1000
            logger.info(f"Gemini (fallback) responded in {elapsed:.0f}ms")
            return AIResult(
                content=res.text.strip(),
                provider="gemini",
                latency_ms=elapsed,
                fallback_used=True,
            )
        except Exception as e:
            logger.warning(f"Gemini key failed: {str(e)[:80]}")
            if "429" in str(e):
                entry["cooldown_until"] = datetime.now(timezone.utc) + timedelta(minutes=5)
            continue


    # ── Fallback 2: OpenRouter pool ──
    import urllib.request
    for entry in openrouter_clients:
        if not _client_available(entry):
            continue
        try:
            payload = json.dumps({
                "model": "meta-llama/llama-3.3-70b-instruct",
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=payload,
                headers={
                    "Authorization": f"Bearer {entry['key']}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://interviewcoach.duckdns.org",
                    "X-Title": "InterviewCoach",
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
            elapsed = (time.monotonic() - start) * 1000
            logger.info(f"OpenRouter (fallback) responded in {elapsed:.0f}ms")
            return AIResult(
                content=data["choices"][0]["message"]["content"],
                provider="openrouter",
                latency_ms=elapsed,
                fallback_used=True,
            )
        except Exception as e:
            logger.warning(f"OpenRouter key failed: {str(e)[:80]}")
            if "429" in str(e) or "rate" in str(e).lower():
                entry["cooldown_until"] = datetime.now(timezone.utc) + timedelta(minutes=5)
            continue

    # ── All keys exhausted ──
    elapsed = (time.monotonic() - start) * 1000
    logger.error("All AI provider keys exhausted or on cooldown")
    return AIResult(
        content="AI providers temporarily unavailable. Please try again in a few minutes.",
        provider="none",
        latency_ms=elapsed,
        fallback_used=True,
    )


# --------------------------------------------------
# Database (sync — called via asyncio.to_thread)
# --------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS interviews (
                session_id   TEXT PRIMARY KEY,
                role         TEXT NOT NULL,
                difficulty   TEXT NOT NULL,
                started_at   TEXT NOT NULL,
                completed_at TEXT,
                completed    INTEGER DEFAULT 0,
                resume_text  TEXT DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role       TEXT NOT NULL,
                content    TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS evaluations (
                session_id      TEXT PRIMARY KEY,
                overall_score   INTEGER,
                communication   INTEGER,
                technical_depth INTEGER,
                problem_solving INTEGER,
                strengths       TEXT,
                weak_areas      TEXT,
                summary         TEXT,
                created_at      TEXT NOT NULL
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _db_insert_interview(session_id, role, difficulty):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO interviews (session_id, role, difficulty, started_at) VALUES (?,?,?,?)",
            (session_id, role, difficulty, _now()),
        )
        conn.commit()
    finally:
        conn.close()


def _db_save_message(session_id, role, content):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
            (session_id, role, content, _now()),
        )
        conn.commit()
    finally:
        conn.close()


def _db_save_evaluation(session_id, ev: dict):
    conn = get_db()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO evaluations
               (session_id, overall_score, communication, technical_depth,
                problem_solving, strengths, weak_areas, summary, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                session_id,
                ev.get("overall_score", 0),
                ev.get("communication", 0),
                ev.get("technical_depth", 0),
                ev.get("problem_solving", 0),
                json.dumps(ev.get("strengths", [])),
                json.dumps(ev.get("weak_areas", [])),
                ev.get("summary", ""),
                _now(),
            ),
        )
        conn.execute(
            "UPDATE interviews SET completed=1, completed_at=? WHERE session_id=?",
            (_now(), session_id),
        )
        conn.commit()
    finally:
        conn.close()


def _db_set_resume(session_id, text):
    conn = get_db()
    try:
        conn.execute(
            "UPDATE interviews SET resume_text=? WHERE session_id=?",
            (text, session_id),
        )
        conn.commit()
    finally:
        conn.close()


def _db_get_history(limit=30):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT i.session_id, i.role, i.difficulty, i.started_at,
                      i.completed_at, i.completed, e.overall_score
               FROM interviews i
               LEFT JOIN evaluations e ON i.session_id = e.session_id
               ORDER BY i.started_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _db_get_detail(session_id):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM interviews WHERE session_id=?", (session_id,)
        ).fetchone()
        if not row:
            return None
        msgs = conn.execute(
            "SELECT role, content, created_at FROM messages WHERE session_id=? ORDER BY id",
            (session_id,),
        ).fetchall()
        ev = conn.execute(
            "SELECT * FROM evaluations WHERE session_id=?", (session_id,)
        ).fetchone()

        result = dict(row)
        result["messages"] = [dict(m) for m in msgs]
        if ev:
            e = dict(ev)
            e["strengths"] = json.loads(e["strengths"])
            e["weak_areas"] = json.loads(e["weak_areas"])
            result["evaluation"] = e
        else:
            result["evaluation"] = None
        return result
    finally:
        conn.close()


def _db_delete_session(session_id):
    conn = get_db()
    try:
        conn.execute("DELETE FROM evaluations WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM interviews WHERE session_id=?", (session_id,))
        conn.commit()
    finally:
        conn.close()


def _db_hydrate_session(session_id):
    """Load session metadata + messages from DB. Returns (meta_dict, messages_list) or (None, [])."""
    conn = get_db()
    try:
        meta = conn.execute(
            "SELECT * FROM interviews WHERE session_id=?", (session_id,)
        ).fetchone()
        if not meta:
            return None, []
        msgs = conn.execute(
            "SELECT role, content FROM messages WHERE session_id=? ORDER BY id",
            (session_id,),
        ).fetchall()
        return dict(meta), [{"role": m["role"], "content": m["content"]} for m in msgs]
    finally:
        conn.close()


# --------------------------------------------------
# InterviewSession — encapsulated state & mutations
# --------------------------------------------------

class InterviewSession:
    """
    Owns all mutable state for a single interview.
    All mutations go through methods — no external dict poking.
    Each session has its own asyncio.Lock for concurrency safety.
    """

    __slots__ = (
        "session_id", "role", "difficulty", "lock",
        "_history", "_user_answer_count", "_completed",
        "_resume_text", "_questions_asked", "_last_accessed",
        "_memory",
    )

    def __init__(self, session_id: str, role: str, difficulty: str):
        self.session_id = session_id
        self.role = role
        self.difficulty = difficulty
        self.lock = asyncio.Lock()
        self._history: list[dict] = []
        self._user_answer_count: int = 0
        self._completed: bool = False
        self._resume_text: str = ""
        self._questions_asked: list[str] = []  # tracks AI questions for derived memory
        self._memory: dict = _default_memory()
        self._last_accessed = datetime.now(timezone.utc)

    # ── Properties (read-only access) ──

    @property
    def history(self) -> list[dict]:
        """Return a copy — callers cannot mutate internals directly."""
        return list(self._history)

    @property
    def context_messages(self) -> list[dict]:
        """Return trimmed history window for AI context."""
        return list(self._history[-HISTORY_CONTEXT_WINDOW:])

    @property
    def user_answer_count(self) -> int:
        return self._user_answer_count

    @property
    def completed(self) -> bool:
        return self._completed

    @property
    def resume_text(self) -> str:
        return self._resume_text

    @property
    def questions_asked(self) -> list[str]:
        return list(self._questions_asked)

    @property
    def memory(self) -> dict:
        """Return a copy of semantic memory — callers cannot mutate internals."""
        return dict(self._memory)

    @property
    def needs_memory_update(self) -> bool:
        return self._user_answer_count > 0 and self._user_answer_count % MEMORY_UPDATE_EVERY == 0

    @property
    def last_accessed(self) -> datetime:
        return self._last_accessed

    @property
    def is_stale(self) -> bool:
        return datetime.now(timezone.utc) - self._last_accessed > SESSION_TTL

    @property
    def should_evaluate(self) -> bool:
        return self._user_answer_count >= MAX_QUESTIONS

    # ── Mutation methods ──

    def add_user_message(self, content: str):
        """Record a user message and increment answer count."""
        self._history.append({"role": "user", "content": content})
        self._user_answer_count += 1
        self._last_accessed = datetime.now(timezone.utc)

    def add_ai_message(self, content: str):
        """Record an AI message and extract the question for derived memory."""
        self._history.append({"role": "assistant", "content": content})
        # Track question text (first 120 chars) for context compression
        self._questions_asked.append(content[:120])
        self._trim_history()
        self._last_accessed = datetime.now(timezone.utc)

    def set_resume(self, text: str):
        self._resume_text = text
        self._last_accessed = datetime.now(timezone.utc)

    def set_memory(self, memory: dict):
        self._memory = memory

    def mark_completed(self):
        self._completed = True

    def _trim_history(self):
        if len(self._history) > HISTORY_CONTEXT_WINDOW:
            self._history = self._history[-HISTORY_CONTEXT_WINDOW:]

    # ── Hydration (rebuild from DB after restart) ──

    @classmethod
    def from_db(cls, meta: dict, messages: list[dict]) -> "InterviewSession":
        session = cls(meta["session_id"], meta["role"], meta["difficulty"])
        session._history = messages
        session._user_answer_count = len([m for m in messages if m["role"] == "user"])
        session._completed = bool(meta["completed"])
        session._resume_text = meta.get("resume_text", "") or ""
        # Rebuild questions_asked from history
        session._questions_asked = [
            m["content"][:120] for m in messages if m["role"] == "assistant"
        ]
        # Memory will be rebuilt on next memory update cycle
        session._memory = _default_memory()
        return session


# --------------------------------------------------
# SessionManager — owns the sessions dict
# --------------------------------------------------

class SessionManager:
    """
    Central authority for session lifecycle.
    All session access goes through here — no direct dict manipulation.
    """

    def __init__(self):
        self._sessions: dict[str, InterviewSession] = {}

    @property
    def active_count(self) -> int:
        return len(self._sessions)

    def create(self, session_id: str, role: str, difficulty: str) -> InterviewSession:
        session = InterviewSession(session_id, role, difficulty)
        self._sessions[session_id] = session
        return session

    async def get(self, session_id: str) -> InterviewSession | None:
        """
        Return session from cache.
        If missing (e.g. after server restart), hydrate from DB.
        """
        session = self._sessions.get(session_id)
        if session:
            return session

        # Hydrate from DB (in thread to avoid blocking event loop)
        meta, messages = await asyncio.to_thread(_db_hydrate_session, session_id)
        if not meta:
            return None

        session = InterviewSession.from_db(meta, messages)
        self._sessions[session_id] = session
        logger.info(f"Session {session_id[:8]}... hydrated from DB")
        return session

    def remove(self, session_id: str):
        self._sessions.pop(session_id, None)

    def evict_stale(self) -> int:
        stale = [sid for sid, s in self._sessions.items() if s.is_stale]
        for sid in stale:
            del self._sessions[sid]
        return len(stale)


session_mgr = SessionManager()


# --------------------------------------------------
# Lifespan & App
# --------------------------------------------------

async def _periodic_cleanup():
    """Background task: evict stale sessions independently of traffic."""
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SEC)
        evicted = session_mgr.evict_stale()
        if evicted:
            logger.info(f"Background cleanup: evicted {evicted} stale session(s)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(init_db)
    cleanup_task = asyncio.create_task(_periodic_cleanup())
    logger.info("InterviewAI started — background cleanup active")
    yield
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan, root_path="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------
# Prompt Builder
# --------------------------------------------------

def build_system_prompt(session: InterviewSession) -> str:
    depth_guide = {
        "Junior": "Ask foundational questions and guide gently when the candidate struggles.",
        "Mid": "Ask practical real-world questions involving debugging and troubleshooting.",
        "Senior": "Ask architecture, scalability, reliability, and deep troubleshooting questions.",
        "Staff": "Ask leadership, strategic engineering, and system-level questions.",
    }

    count = session.user_answer_count
    if count <= 2:
        phase = "Warm-up — light introductory questions about background, tools, and recent projects. Do NOT jump into deep technical scenarios yet."
    elif count <= 5:
        phase = "Practical — real-world troubleshooting and implementation questions."
    elif count <= 8:
        phase = "Deep dive — architecture, scaling, reliability, and tradeoff questions."
    else:
        phase = "Wrap-up — conclude the interview naturally."

    resume_section = ""
    if session.resume_text:
        resume_section = f"""
CANDIDATE RESUME (use this to personalise your questions — reference their real projects and stack naturally, do NOT recite it back):
--- START ---
{session.resume_text[:3000]}
--- END ---
"""

    # Derived memory: questions already asked — prevents repetition
    prior_questions = ""
    if session.questions_asked:
        recent = session.questions_asked[-6:]
        prior_questions = f"""
QUESTIONS YOU HAVE ALREADY ASKED (do NOT repeat these topics):
{chr(10).join(f'- {q}' for q in recent)}
"""

    # ── Semantic Memory & Adaptive Interviewing ──
    mem = session.memory
    memory_section = ""
    adaptation_section = ""

    if mem.get("topics_covered"):
        memory_section += f"\nTOPICS ALREADY COVERED (ask about NEW topics):\n{', '.join(mem['topics_covered'])}\n"

    if mem.get("strengths_seen"):
        memory_section += f"\nCANDIDATE STRENGTHS OBSERVED:\n{chr(10).join(f'- {s}' for s in mem['strengths_seen'])}\n"

    if mem.get("weak_signals"):
        memory_section += f"\nWEAK AREAS DETECTED (probe these more, but gently):\n{chr(10).join(f'- {w}' for w in mem['weak_signals'])}\n"

    if mem.get("communication_notes"):
        memory_section += f"\nCOMMUNICATION STYLE: {mem['communication_notes']}\n"

    # Adaptive difficulty
    eff_diff = mem.get("effective_difficulty", "as_selected")
    if eff_diff == "easier":
        adaptation_section = f"""
ADAPTATION: The candidate appears to be struggling (confidence: {mem.get('confidence_level', 'unknown')}).
Reason: {mem.get('adaptation_reason', '')}
→ Simplify your next question. Use more concrete, specific scenarios instead of abstract architecture.
→ If they give vague answers, offer a hint or reframe the question.
→ Do NOT make the candidate feel bad. Stay encouraging.
"""
    elif eff_diff == "harder":
        adaptation_section = f"""
ADAPTATION: The candidate is performing strongly (confidence: {mem.get('confidence_level', 'unknown')}).
Reason: {mem.get('adaptation_reason', '')}
→ Increase depth. Ask about edge cases, failure modes, and architectural tradeoffs.
→ Push for deeper reasoning: "What would happen if..." / "How would you handle..." / "What are the tradeoffs?"
→ Don't make it feel like an interrogation — stay conversational but challenging.
"""

    return f"""You are a thoughtful, calm, and professional technical interviewer at a top tech company.

Role: {session.role}
Difficulty: {session.difficulty}
Depth guidance: {depth_guide.get(session.difficulty, "")}
Current phase: {phase}
Candidate has answered {count} question(s) so far.
{resume_section}{prior_questions}{memory_section}{adaptation_section}
INTERVIEW STYLE:
- Be friendly, human, and professional.
- Sound like an experienced real interviewer — not a chatbot.
- Keep responses concise: 1 to 4 sentences normally.
- Ask ONE question at a time. Never ask multiple questions.
- Give brief acknowledgements after answers ("Good point.", "Makes sense.", "Nice approach.").
- Do NOT deeply evaluate answers mid-interview. Save that for the end.
- Do NOT use bullet points in conversation.
- Do NOT repeat the candidate's answer back to them.
- Do NOT use filler phrases like "Great question!" or "Excellent answer!" every time.
- If a resume is provided, acknowledge it briefly and naturally in your opening.

OPENING:
- Start with a warm, short greeting.
- Mention the role and difficulty naturally.
- Begin with light introductory questions. Gradually increase depth.
- Do NOT ask what role the user is preparing for — you already know.
"""


# --------------------------------------------------
# Evaluation
# --------------------------------------------------

EVAL_FALLBACK = {
    "overall_score": 70,
    "communication": 70,
    "technical_depth": 68,
    "problem_solving": 71,
    "strengths": ["Good engagement throughout", "Clear communication"],
    "weak_areas": ["Add more specific examples", "Go deeper on technical concepts"],
    "summary": "Solid performance overall with good foundational knowledge. Focus on adding more real-world examples to strengthen your answers.",
}


def parse_json_from_ai(raw: str) -> dict | None:
    """Robustly extract JSON from AI response with fences, preamble, etc."""
    cleaned = raw.strip()

    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except json.JSONDecodeError:
            pass

    brace_match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


def generate_evaluation(role: str, difficulty: str, history: list[dict], memory: dict | None = None) -> dict:
    # Include memory context so evaluation is informed by observed patterns
    memory_context = ""
    if memory and any(memory.get(k) for k in ["strengths_seen", "weak_signals"]):
        memory_context = f"""

INTERVIEWER OBSERVATIONS DURING THE SESSION:
- Strengths observed: {', '.join(memory.get('strengths_seen', [])) or 'none recorded'}
- Weak signals: {', '.join(memory.get('weak_signals', [])) or 'none recorded'}
- Confidence level: {memory.get('confidence_level', 'unknown')}
- Communication: {memory.get('communication_notes', 'no notes')}
- Topics covered: {', '.join(memory.get('topics_covered', [])) or 'none recorded'}

Use these observations to make your evaluation MORE specific and grounded.
"""

    eval_prompt = f"""You are an expert technical interviewer.

Analyze this completed mock interview for a {difficulty}-level {role} position.
{memory_context}
Return ONLY valid JSON — no explanation, no markdown — in exactly this format:

{{
  "overall_score": 0,
  "communication": 0,
  "technical_depth": 0,
  "problem_solving": 0,
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "weak_areas": ["area 1", "area 2", "area 3"],
  "summary": "2-3 sentence honest summary"
}}

SCORING:
- overall_score: weighted average of all dimensions (0-100)
- communication: clarity, conciseness, articulation (0-100)
- technical_depth: accuracy, depth, correct terminology (0-100)
- problem_solving: reasoning, tradeoffs, real-world thinking (0-100)
- strengths: specific things they did well
- weak_areas: specific, actionable things to improve
- summary: honest, warm, constructive — like a real interviewer's closing thoughts
- Do NOT give unrealistically high scores. Be balanced and realistic.
"""

    result = call_ai(
        [{"role": "system", "content": eval_prompt}] + history,
        max_tokens=500,
        temperature=0.3,
    )
    logger.info(f"Evaluation via {result.provider} in {result.latency_ms:.0f}ms")

    parsed = parse_json_from_ai(result.content)
    if parsed:
        return parsed

    logger.warning("Evaluation JSON parse failed, using fallback")
    return EVAL_FALLBACK


# --------------------------------------------------
# Request Models
# --------------------------------------------------

class StartRequest(BaseModel):
    role: str
    difficulty: str

    @field_validator("difficulty")
    @classmethod
    def validate_difficulty(cls, v):
        if v not in VALID_DIFFICULTIES:
            raise ValueError(f"difficulty must be one of: {VALID_DIFFICULTIES}")
        return v


class ChatRequest(BaseModel):
    session_id: str
    message: str
    role: str
    difficulty: str


class EvalRequest(BaseModel):
    session_id: str


# --------------------------------------------------
# Endpoints
# --------------------------------------------------

@app.get("/")
async def root():
    return {"status": "Interview Prep AI is running!"}


@app.get("/health")
async def health():
    return {"status": "healthy", "active_sessions": session_mgr.active_count}


# ── Start Session ──

@app.post("/session/start")
async def start_session(req: StartRequest):
    session_id = str(uuid.uuid4())

    # Persist to DB (non-blocking)
    await asyncio.to_thread(_db_insert_interview, session_id, req.role, req.difficulty)

    # Create session object
    session = session_mgr.create(session_id, req.role, req.difficulty)

    # Get opening message from AI (in thread — sync HTTP call)
    system_prompt = build_system_prompt(session)
    result = await asyncio.to_thread(
        call_ai,
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "__START__"},
        ],
        200,
        0.75,
    )
    logger.info(f"Session {session_id[:8]}... started via {result.provider} ({result.latency_ms:.0f}ms)")

    # Persist + update session (under lock)
    await asyncio.to_thread(_db_save_message, session_id, "assistant", result.content)
    async with session.lock:
        session.add_ai_message(result.content)

    return {"session_id": session_id, "response": result.content}


# ── Chat ──

@app.post("/chat")
async def chat(req: ChatRequest):
    session = await session_mgr.get(req.session_id)
    if not session:
        return {"error": "Session not found"}

    async with session.lock:
        if session.completed:
            return {"error": "Interview already completed"}

        # Record user answer
        session.add_user_message(req.message)

    # Persist user message (non-blocking, outside lock)
    await asyncio.to_thread(_db_save_message, req.session_id, "user", req.message)

    # ── Update semantic memory (every N answers) ──
    if session.needs_memory_update:
        current_mem = session.memory
        recent = session.context_messages
        updated_mem = await asyncio.to_thread(
            update_memory, current_mem, recent, session.role, session.difficulty
        )
        async with session.lock:
            session.set_memory(updated_mem)

    # ── Check if interview should end ──
    if session.should_evaluate:
        history = session.history  # returns a copy
        mem = session.memory
        evaluation = await asyncio.to_thread(
            generate_evaluation, req.role, req.difficulty, history, mem
        )
        await asyncio.to_thread(_db_save_evaluation, req.session_id, evaluation)
        async with session.lock:
            session.mark_completed()
        return {"completed": True, "evaluation": evaluation}

    # ── Continue interview (prompt now includes memory + adaptation) ──
    system_prompt = build_system_prompt(session)
    context = session.context_messages  # returns a copy

    result = await asyncio.to_thread(
        call_ai,
        [{"role": "system", "content": system_prompt}] + context,
        200,
        0.75,
    )

    # Persist + update session
    await asyncio.to_thread(_db_save_message, req.session_id, "assistant", result.content)
    async with session.lock:
        session.add_ai_message(result.content)

    return {
        "completed": False,
        "response": result.content,
        "question_count": session.user_answer_count + 1,  # 1-based for frontend compat
        "memory": session.memory,  # expose to frontend for real-time insight display
    }


# ── Streaming Chat (SSE) ──


async def _generate_stream(session: InterviewSession, req: ChatRequest):
    """SSE generator: streams tokens from Groq, falls back to Gemini batch."""
    system_prompt = build_system_prompt(session)
    context = session.context_messages
    msgs = [{"role": "system", "content": system_prompt}] + context

    full_content = ""
    q = thread_queue.Queue()

    def _groq_stream():
        for entry in groq_clients:
            if not _client_available(entry):
                continue
            try:
                stream = entry["client"].chat.completions.create(
                    model="llama-3.3-70b-versatile",
                    messages=msgs,
                    max_tokens=200,
                    temperature=0.75,
                    stream=True,
                )
                for chunk in stream:
                    delta = chunk.choices[0].delta
                    if delta and delta.content:
                        q.put(delta.content)
                q.put(None)  # done sentinel
                return  # success — exit the loop
            except Exception as e:
                logger.warning(f"Groq stream key failed: {str(e)[:80]}")
                if "429" in str(e):
                    entry["cooldown_until"] = datetime.now(timezone.utc) + timedelta(minutes=5)
                continue
        # All Groq keys failed — signal fallback
        q.put(Exception("All Groq keys exhausted for streaming"))

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _groq_stream)

    try:
        while True:
            item = await loop.run_in_executor(None, lambda: q.get(timeout=30))
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            full_content += item
            yield f"data: {json.dumps({'type': 'token', 'content': item})}\n\n"
    except Exception as e:
        logger.warning(f"Stream failed: {str(e)[:80]} — Gemini fallback")
        result = call_ai(msgs, 200, 0.75)
        full_content = result.content
        yield f"data: {json.dumps({'type': 'token', 'content': full_content})}\n\n"

    # Persist + update session
    await asyncio.to_thread(_db_save_message, req.session_id, "assistant", full_content)
    async with session.lock:
        session.add_ai_message(full_content)

    yield f"data: {json.dumps({'type': 'done', 'question_count': session.user_answer_count + 1, 'memory': session.memory})}\n\n"


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """SSE streaming version of /chat — tokens arrive in real time."""
    session = await session_mgr.get(req.session_id)
    if not session:
        return {"error": "Session not found"}

    async with session.lock:
        if session.completed:
            return {"error": "Interview already completed"}
        session.add_user_message(req.message)

    await asyncio.to_thread(_db_save_message, req.session_id, "user", req.message)

    # Memory update
    if session.needs_memory_update:
        current_mem = session.memory
        recent = session.context_messages
        updated_mem = await asyncio.to_thread(
            update_memory, current_mem, recent, session.role, session.difficulty
        )
        async with session.lock:
            session.set_memory(updated_mem)

    # Evaluation (non-streaming)
    if session.should_evaluate:
        history = session.history
        mem = session.memory
        evaluation = await asyncio.to_thread(
            generate_evaluation, req.role, req.difficulty, history, mem
        )
        await asyncio.to_thread(_db_save_evaluation, req.session_id, evaluation)
        async with session.lock:
            session.mark_completed()
        return {"completed": True, "evaluation": evaluation}

    return StreamingResponse(
        _generate_stream(session, req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ── End Interview Early ──

@app.post("/session/end")
async def end_session_early(req: EvalRequest):
    session = await session_mgr.get(req.session_id)
    if not session:
        return {"error": "Session not found"}

    async with session.lock:
        if session.completed:
            return {"error": "Interview already completed"}
        if session.user_answer_count < 2:
            return {"error": "Answer at least 2 questions before ending the interview."}

    history = session.history
    mem = session.memory
    evaluation = await asyncio.to_thread(
        generate_evaluation, session.role, session.difficulty, history, mem
    )
    await asyncio.to_thread(_db_save_evaluation, req.session_id, evaluation)
    async with session.lock:
        session.mark_completed()

    return {"completed": True, "evaluation": evaluation}


# ── Upload Resume ──

@app.post("/session/upload-resume")
async def upload_resume(
    session_id: str = Form(...),
    file: UploadFile = File(...),
):
    session = await session_mgr.get(session_id)
    if not session:
        return {"error": "Session not found"}

    filename = file.filename or ""
    allowed = (".pdf", ".txt", ".md")
    if not any(filename.lower().endswith(ext) for ext in allowed):
        return {"error": "Only PDF, TXT, and MD files are supported"}

    content = await file.read()

    if len(content) > MAX_RESUME_BYTES:
        return {"error": f"File too large. Maximum size is {MAX_RESUME_BYTES // (1024 * 1024)} MB."}

    if filename.lower().endswith(".pdf"):
        try:
            pages = PdfReader(io.BytesIO(content)).pages
            resume_text = "\n".join(p.extract_text() or "" for p in pages).strip()
        except Exception:
            return {"error": "Could not read PDF. The file may be corrupted or encrypted."}
    else:
        try:
            resume_text = content.decode("utf-8").strip()
        except UnicodeDecodeError:
            resume_text = content.decode("latin-1").strip()

    if not resume_text:
        return {"error": "Could not extract text from file. Try a different format."}

    await asyncio.to_thread(_db_set_resume, session_id, resume_text)
    async with session.lock:
        session.set_resume(resume_text)

    return {
        "status": "ok",
        "filename": filename,
        "characters": len(resume_text),
    }


# ── TTS ──

class TTSRequest(BaseModel):
    text: str
    voice: str = "Fritz-PlayAI"


@app.post("/tts")
async def text_to_speech(req: TTSRequest):
    """Convert text to speech using Groq TTS (playai-tts)."""
    if not req.text or not req.text.strip():
        return {"error": "No text provided"}

    text = req.text.strip()[:500]

    for entry in groq_clients:
        if not _client_available(entry):
            continue
        try:
            response = entry["client"].audio.speech.create(
                model="playai-tts",
                voice=req.voice,
                input=text,
                response_format="mp3",
            )
            audio_bytes = response.content
            return StreamingResponse(
                io.BytesIO(audio_bytes),
                media_type="audio/mpeg",
                headers={"Content-Disposition": "inline", "Cache-Control": "no-cache"},
            )
        except Exception as e:
            logger.warning(f"Groq TTS key failed: {str(e)[:100]}")
            if "429" in str(e) or "rate" in str(e).lower():
                entry["cooldown_until"] = datetime.now(timezone.utc) + timedelta(minutes=5)
            continue

    logger.error("All Groq TTS keys failed")
    return {"error": "TTS temporarily unavailable"}


# ── Transcribe (Whisper STT) ──

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Receive audio blob from frontend (webm/wav),
    send to Groq Whisper, return transcript text.
    Whisper handles technical vocabulary far better than Web Speech API.
    """
    audio_bytes = await file.read()
    if not audio_bytes:
        return {"error": "No audio received"}

    # Try each Groq key
    for entry in groq_clients:
        if not _client_available(entry):
            continue
        try:
            # Groq expects a file-like with a name so it knows the format
            audio_file = (file.filename or "audio.webm", io.BytesIO(audio_bytes), file.content_type or "audio/webm")

            result = entry["client"].audio.transcriptions.create(
                model="whisper-large-v3",
                file=audio_file,
                language="en",
                response_format="text",
            )

            # result is plain text when response_format="text"
            text = result.strip() if isinstance(result, str) else result.text.strip()
            logger.info(f"Whisper transcript: {text[:80]}")
            return {"transcript": text}

        except Exception as e:
            logger.warning(f"Whisper failed on key: {str(e)[:100]}")
            if "429" in str(e) or "rate" in str(e).lower():
                entry["cooldown_until"] = datetime.now(timezone.utc) + timedelta(minutes=5)
            continue

    return {"error": "Transcription failed — all keys exhausted"}


# ── Delete Session ──

@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    session_mgr.remove(session_id)
    await asyncio.to_thread(_db_delete_session, session_id)
    return {"status": "session ended"}


# ── History List ──

@app.get("/history")
async def get_history(limit: int = 30):
    records = await asyncio.to_thread(_db_get_history, limit)
    return {"interviews": records}


# ── History Detail ──

@app.get("/history/{session_id}")
async def get_history_detail(session_id: str):
    detail = await asyncio.to_thread(_db_get_detail, session_id)
    if not detail:
        return {"error": "Session not found"}
    return detail


# ── Session Memory (live insight for frontend) ──

@app.get("/session/{session_id}/memory")
async def get_session_memory(session_id: str):
    session = await session_mgr.get(session_id)
    if not session:
        return {"error": "Session not found"}
    return {"memory": session.memory}