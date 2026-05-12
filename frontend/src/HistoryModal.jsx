import { useState, useEffect, useRef } from "react"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000"

const MODAL_STYLES = `
.modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.7); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  animation: fadeIn .2s ease;
}
@keyframes fadeIn { from { opacity:0 } to { opacity:1 } }

.modal {
  background: var(--surface); border: 1px solid var(--border2);
  border-radius: 16px; width: 860px; max-width: calc(100vw - 40px);
  height: 80vh; display: flex; flex-direction: column;
  overflow: hidden; animation: slideUp .25s ease;
  box-shadow: 0 25px 60px rgba(0,0,0,0.5);
}
@keyframes slideUp { from { opacity:0; transform:translateY(20px) } to { opacity:1; transform:translateY(0) } }

.modal-header {
  padding: 18px 22px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.modal-title { font-size: 15px; font-weight: 600; }
.modal-meta { font-size: 12px; color: var(--text3); margin-top: 2px; }
.modal-close {
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border);
  background: transparent; color: var(--text2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; transition: all .15s;
}
.modal-close:hover { background: rgba(239,68,68,0.1); color: #f87171; border-color: rgba(239,68,68,0.3); }

.modal-body {
  display: grid; grid-template-columns: 1fr 260px;
  flex: 1; overflow: hidden;
}

.modal-chat {
  padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
  border-right: 1px solid var(--border);
}
.modal-chat::-webkit-scrollbar { width: 4px; }
.modal-chat::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 4px; }

.modal-msg { display: flex; gap: 10px; }
.modal-msg.user { flex-direction: row-reverse; }
.modal-avatar {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
}
.modal-avatar.ai { background: linear-gradient(135deg, var(--accent), var(--accent2)); }
.modal-avatar.user { background: var(--surface3); color: var(--text2); }
.modal-bubble {
  max-width: 78%; padding: 10px 14px; border-radius: 13px;
  font-size: 13px; line-height: 1.65;
}
.modal-bubble.ai {
  background: var(--surface2); border: 1px solid var(--border);
  border-top-left-radius: 4px; color: var(--text);
}
.modal-bubble.user {
  background: var(--accent); color: #fff; border-top-right-radius: 4px;
}

.modal-eval {
  padding: 18px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
}
.modal-eval::-webkit-scrollbar { width: 0; }

.modal-section-label {
  font-size: 10px; font-weight: 600; letter-spacing: 1.2px;
  color: var(--text3); text-transform: uppercase; margin-bottom: 8px;
}

.modal-score-ring {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.modal-ring { position: relative; width: 80px; height: 80px; }
.modal-ring svg { transform: rotate(-90deg); }
.modal-ring-center {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%); text-align: center;
}
.modal-score-num {
  font-size: 22px; font-weight: 600;
  font-family: 'DM Mono', monospace; letter-spacing: -1px;
}
.modal-score-max { font-size: 10px; color: var(--text3); }

.modal-criteria-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.modal-criteria-header { display: flex; justify-content: space-between; font-size: 12px; }
.modal-criteria-name { color: var(--text2); }
.modal-criteria-score { color: var(--text3); font-family: 'DM Mono', monospace; }
.modal-criteria-bar-bg { height: 3px; background: var(--surface3); border-radius: 3px; overflow: hidden; }
.modal-criteria-bar { height: 100%; border-radius: 3px; transition: width .6s ease; }

.modal-tag {
  padding: 6px 9px; border-radius: 7px; font-size: 11px;
  margin-bottom: 5px; line-height: 1.5;
}
.modal-tag.green { background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.25); color: #86efac; }
.modal-tag.amber { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.25); color: #fbbf24; }

.modal-summary {
  font-size: 12px; line-height: 1.7; color: var(--text2);
  background: var(--surface2); padding: 10px; border-radius: 8px;
  border: 1px solid var(--border);
}

.modal-loading {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--text3); font-size: 13px; gap: 10px;
}
.modal-spinner {
  width: 20px; height: 20px; border: 2px solid var(--surface3);
  border-top-color: var(--accent); border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
`

export default function HistoryModal({ session, onClose }) {
  const [detail, setDetail]   = useState(null)
  const [loading, setLoading] = useState(true)
  const scrollRef             = useRef(null)

  useEffect(() => {
    if (!session) return
    setLoading(true)
    fetch(`${API_URL}/history/${session.session_id}`)
      .then(r => r.json())
      .then(data => {
        setDetail(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [session])

  useEffect(() => {
    if (detail) setTimeout(() => scrollRef.current?.scrollIntoView({ behavior: "smooth" }), 100)
  }, [detail])

  // Close on overlay click or Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onClose])

  if (!session) return null

  const ev        = detail?.evaluation
  const messages  = detail?.messages || []
  const circleLen = 2 * Math.PI * 32
  const score     = ev?.overall_score ?? 0
  const scoreColor = score >= 80 ? "var(--green)" : score >= 60 ? "var(--amber)" : "var(--red)"

  const formatDate = (iso) => {
    if (!iso) return ""
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  }

  return (
    <>
      <style>{MODAL_STYLES}</style>
      <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className="modal">

          {/* Header */}
          <div className="modal-header">
            <div>
              <div className="modal-title">{session.role} Interview</div>
              <div className="modal-meta">
                {session.difficulty} · {formatDate(session.completed_at)}
                {ev && ` · Score: ${ev.overall_score}/100`}
              </div>
            </div>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>

          {/* Body */}
          <div className="modal-body">

            {/* Chat */}
            <div className="modal-chat">
              {loading ? (
                <div className="modal-loading">
                  <div className="modal-spinner"/>
                  Loading conversation...
                </div>
              ) : messages.length === 0 ? (
                <div className="modal-loading">No messages found for this session</div>
              ) : (
                <>
                  {messages.map((msg, i) => (
                    <div key={i} className={`modal-msg${msg.role === "user" ? " user" : ""}`}>
                      <div className={`modal-avatar${msg.role === "user" ? " user" : " ai"}`}>
                        {msg.role === "user" ? "You" : "AI"}
                      </div>
                      <div className={`modal-bubble${msg.role === "user" ? " user" : " ai"}`}>
                        {msg.content}
                      </div>
                    </div>
                  ))}
                  <div ref={scrollRef}/>
                </>
              )}
            </div>

            {/* Evaluation */}
            <div className="modal-eval">
              {ev ? (
                <>
                  <div>
                    <div className="modal-section-label">Final score</div>
                    <div className="modal-score-ring">
                      <div className="modal-ring">
                        <svg width="80" height="80" viewBox="0 0 80 80">
                          <circle cx="40" cy="40" r="32" fill="none" stroke="var(--surface3)" strokeWidth="6"/>
                          <circle cx="40" cy="40" r="32" fill="none" stroke={scoreColor} strokeWidth="6"
                            strokeDasharray={circleLen}
                            strokeDashoffset={circleLen - (score / 100) * circleLen}
                            strokeLinecap="round"
                            style={{ transition: "stroke-dashoffset .8s ease" }}
                          />
                        </svg>
                        <div className="modal-ring-center">
                          <div className="modal-score-num" style={{ color: scoreColor }}>{score}</div>
                          <div className="modal-score-max">/100</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="modal-section-label">Breakdown</div>
                    {[
                      { name: "Communication",   score: ev.communication,   color: "var(--accent)" },
                      { name: "Technical depth", score: ev.technical_depth, color: "var(--amber)"  },
                      { name: "Problem solving", score: ev.problem_solving, color: "var(--green)"  },
                    ].map(c => (
                      <div key={c.name} className="modal-criteria-row">
                        <div className="modal-criteria-header">
                          <span className="modal-criteria-name">{c.name}</span>
                          <span className="modal-criteria-score">{c.score}</span>
                        </div>
                        <div className="modal-criteria-bar-bg">
                          <div className="modal-criteria-bar" style={{ width: `${c.score}%`, background: c.color }}/>
                        </div>
                      </div>
                    ))}
                  </div>

                  {ev.strengths?.length > 0 && (
                    <div>
                      <div className="modal-section-label">Strengths</div>
                      {ev.strengths.map((s, i) => (
                        <div key={i} className="modal-tag green">{s}</div>
                      ))}
                    </div>
                  )}

                  {ev.weak_areas?.length > 0 && (
                    <div>
                      <div className="modal-section-label">Improve</div>
                      {ev.weak_areas.map((w, i) => (
                        <div key={i} className="modal-tag amber">{w}</div>
                      ))}
                    </div>
                  )}

                  {ev.summary && (
                    <div>
                      <div className="modal-section-label">Summary</div>
                      <div className="modal-summary">{ev.summary}</div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text3)", padding: "20px 0", textAlign: "center" }}>
                  No evaluation available
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </>
  )
}