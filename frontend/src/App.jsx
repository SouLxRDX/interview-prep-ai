import { useState, useRef, useEffect, useCallback } from "react"
import useVoiceInterview from "./useVoiceInterview"
import VoicePanel from "./VoicePanel"
import HistoryModal from "./HistoryModal"

const API_URL = "http://a887eaa94764b4313ab15bdab6e2ef43-652016659.ap-south-1.elb.amazonaws.com/api"

const DEFAULT_ROLES = [
  { id: "devops",   label: "DevOps Engineer",   topics: ["CI/CD","Kubernetes","Monitoring","Networking","Security"] },
  { id: "backend",  label: "Backend Engineer",   topics: ["APIs","Databases","System Design","Caching","Auth"] },
  { id: "frontend", label: "Frontend Engineer",  topics: ["React","Performance","CSS","Testing","Accessibility"] },
  { id: "ml",       label: "ML Engineer",        topics: ["Training","Deployment","Data Pipelines","Evaluation","MLOps"] },
]
const DIFFICULTIES = ["Junior","Mid","Senior","Staff"]

export default function App() {
  const [messages, setMessages]                     = useState([])
  const [input, setInput]                           = useState("")
  const [loading, setLoading]                       = useState(false)
  const [starting, setStarting]                     = useState(false)
  const [evaluating, setEvaluating]                 = useState(false)
  const [sessionId, setSessionId]                   = useState(null)
  const [roles, setRoles]                           = useState(DEFAULT_ROLES)
  const [activeRole, setActiveRole]                 = useState(0)
  const [activeDiff, setActiveDiff]                 = useState(1)
  const [questionCount, setQuestionCount]           = useState(0)
  const [answered, setAnswered]                     = useState(0)
  const [duration, setDuration]                     = useState(0)
  const [topicCoverage, setTopicCoverage]           = useState([0,0,0,0,0])
  const [customRoleInput, setCustomRoleInput]       = useState("")
  const [showAddRole, setShowAddRole]               = useState(false)
  const [resumeFile, setResumeFile]                 = useState(null)
  const [resumeStatus, setResumeStatus]             = useState("")

  // ── Evaluation state ──
  const [evaluation, setEvaluation]                 = useState(null)
  const [interviewCompleted, setInterviewCompleted] = useState(false)

  // ── History from DB ──
  const [history, setHistory]           = useState([])
  const [selectedHistory, setSelectedHistory] = useState(null)

  const messagesEndRef = useRef(null)
  const textareaRef    = useRef(null)
  const durationRef    = useRef(null)
  const fileInputRef   = useRef(null)

  const role       = roles[activeRole]
  const difficulty = DIFFICULTIES[activeDiff]

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }) }, [messages, loading])

  // ── Fetch history from DB — must be defined BEFORE handleVoiceComplete ──
  const fetchHistory = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/history`)
      const data = await res.json()
      setHistory((data.interviews || []).filter(h => h.completed === 1))
    } catch {}
  }, [])

  useEffect(() => { fetchHistory() }, [])

  // ── Voice: handle interview completion ──
  const handleVoiceComplete = useCallback(({ messages: voiceMsgs, evaluation: voiceEval }) => {
    setMessages(voiceMsgs)
    setInterviewCompleted(true)
    setEvaluating(true)
    setTimeout(() => {
      setEvaluation(voiceEval)
      setEvaluating(false)
      fetchHistory()
    }, 1200)
  }, [fetchHistory])

  const voice = useVoiceInterview({ onComplete: handleVoiceComplete })

  // ── Start Session ──
  const startSession = useCallback(async (roleLabel, diff) => {
    setStarting(true)
    setMessages([])
    setQuestionCount(0)
    setAnswered(0)
    setEvaluation(null)
    setInterviewCompleted(false)
    setEvaluating(false)
    setTopicCoverage([0,0,0,0,0])
    if (durationRef.current) clearInterval(durationRef.current)
    setDuration(0)
    try {
      const res  = await fetch(`${API_URL}/session/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleLabel, difficulty: diff }),
      })
      const data = await res.json()
      setSessionId(data.session_id)
      setMessages([{ role: "assistant", content: data.response }])
      setQuestionCount(1)
      durationRef.current = setInterval(() => setDuration(d => d + 1), 60000)
    } catch {
      setMessages([{ role: "assistant", content: "Could not connect to backend." }])
    } finally {
      setStarting(false)
    }
  }, [])

  useEffect(() => {
    startSession(role.label, difficulty)
    return () => { if (durationRef.current) clearInterval(durationRef.current) }
  }, []) // eslint-disable-line

  // ── Send Message ──
  const sendMessage = async () => {
    if (!input.trim() || loading || !sessionId) return
    const userMsg = { role: "user", content: input }
    setMessages(prev => [...prev, userMsg])
    setInput("")
    setLoading(true)
    if (textareaRef.current) textareaRef.current.style.height = "52px"

    try {
      const res  = await fetch(`${API_URL}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: input, role: role.label, difficulty }),
      })
      const data = await res.json()

      // ── Interview completed — show real evaluation ──
      if (data.completed === true) {
        clearInterval(durationRef.current)
        setInterviewCompleted(true)
        setEvaluating(true)
        setAnswered(a => a + 1)
        setMessages(prev => [...prev, {
          role: "assistant",
          content: "That wraps up our session! Your evaluation is ready on the right. 🎯"
        }])
        setTimeout(() => {
          setEvaluation(data.evaluation)
          setEvaluating(false)
          fetchHistory() // refresh history after completion
        }, 1200)
        return
      }

      // ── Normal response ──
      setMessages(prev => [...prev, { role: "assistant", content: data.response }])
      setAnswered(a => a + 1)
      if (data.question_count) setQuestionCount(data.question_count)
      else setQuestionCount(q => q + 1)

      setTopicCoverage(prev => {
        const n = [...prev]
        const i = Math.floor(Math.random() * n.length)
        n[i] = Math.min(100, n[i] + Math.floor(Math.random() * 12) + 5)
        return n
      })

    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Connection error." }])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown  = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage() } }
  const handleInput    = (e) => { setInput(e.target.value); e.target.style.height = "52px"; e.target.style.height = Math.min(e.target.scrollHeight, 110) + "px" }
  const handleRoleChange = (i) => { if (i === activeRole) return; setActiveRole(i); startSession(roles[i].label, difficulty) }
  const handleDiffChange = (i) => { if (i === activeDiff) return; setActiveDiff(i); startSession(role.label, DIFFICULTIES[i]) }

  const addCustomRole = () => {
    const label = customRoleInput.trim()
    if (!label) return
    const id = label.toLowerCase().replace(/\s+/g, "_")
    if (roles.find(r => r.id === id)) { setCustomRoleInput(""); setShowAddRole(false); return }
    const newRole = { id, label, topics: ["Topic 1","Topic 2","Topic 3","Topic 4","Topic 5"] }
    setRoles(prev => [...prev, newRole])
    setActiveRole(roles.length)
    setCustomRoleInput("")
    setShowAddRole(false)
    startSession(label, difficulty)
  }

  const removeCustomRole = (i) => {
    if (i < DEFAULT_ROLES.length) return
    setRoles(prev => prev.filter((_, idx) => idx !== i))
    if (activeRole >= i) setActiveRole(Math.max(0, activeRole - 1))
  }

  const handleResumeUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !sessionId) return
    setResumeFile(file)
    setResumeStatus("uploading")
    try {
      const formData = new FormData()
      formData.append("session_id", sessionId)
      formData.append("file", file)
      const res  = await fetch(`${API_URL}/session/upload-resume`, { method: "POST", body: formData })
      const data = await res.json()
      if (data.error) setResumeStatus("error: " + data.error)
      else setResumeStatus(`✓ ${data.filename} (${data.characters} chars)`)
    } catch { setResumeStatus("Upload failed") }
  }

  // ── Evaluation derived values ──
  const evalScore  = evaluation?.overall_score ?? 0
  const circleLen  = 2 * Math.PI * 36
  const scoreColor = evalScore >= 80 ? "var(--green)" : evalScore >= 60 ? "var(--amber)" : "var(--red)"
  const progress   = Math.max(0, questionCount - 1)

  const effectiveAnswered = voice.voiceActive ? voice.voiceAnswered : answered
  const effectiveQCount   = voice.voiceActive ? voice.voiceQuestionCount : questionCount

  // ── Format history date ──
  const formatDate = (iso) => {
    if (!iso) return ""
    const d    = new Date(iso)
    const now  = new Date()
    const diff = Math.floor((now - d) / 86400000)
    if (diff === 0) return "Today"
    if (diff === 1) return "Yesterday"
    return `${diff} days ago`
  }

  return (
    <>
      <style>{STYLES}</style>
      <div className="app">

        {/* ── Sidebar ── */}
        <div className="sidebar">
          <div className="logo">
            <div className="logo-icon">🎯</div>
            <div className="logo-text">Interview<span>Coach</span></div>
          </div>

          <div>
            <div className="section-label">Role</div>
            <div style={{display:"flex",flexDirection:"column",gap:5,marginTop:8}}>
              {roles.map((r,i) => (
                <div key={r.id} style={{display:"flex",gap:4,alignItems:"center"}}>
                  <button className={`role-btn${activeRole===i?" active":""}`} onClick={()=>handleRoleChange(i)} disabled={starting||voice.voiceActive} style={{flex:1}}>
                    <span className="role-dot"/>{r.label}
                  </button>
                  {i >= DEFAULT_ROLES.length && (
                    <button className="role-remove-btn" onClick={()=>removeCustomRole(i)} title="Remove">×</button>
                  )}
                </div>
              ))}
              {showAddRole ? (
                <div className="add-role-wrap">
                  <input className="add-role-input" value={customRoleInput} onChange={e=>setCustomRoleInput(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter")addCustomRole();if(e.key==="Escape")setShowAddRole(false)}}
                    placeholder="e.g. Data Engineer" autoFocus />
                  <button className="add-role-confirm" onClick={addCustomRole} disabled={!customRoleInput.trim()}>✓</button>
                  <button className="add-role-cancel" onClick={()=>{setShowAddRole(false);setCustomRoleInput("")}}>✕</button>
                </div>
              ) : (
                <button className="add-role-btn" onClick={()=>setShowAddRole(true)} disabled={starting||voice.voiceActive}>+ Add role</button>
              )}
            </div>
          </div>

          <div>
            <div className="section-label">Difficulty</div>
            <div className="diff-row" style={{marginTop:8}}>
              {DIFFICULTIES.map((d,i) => (
                <button key={d} className={`diff-btn${activeDiff===i?" active":""}`} onClick={()=>handleDiffChange(i)} disabled={starting||voice.voiceActive}>{d}</button>
              ))}
            </div>
          </div>

          <div>
            <div className="section-label">Resume</div>
            <div style={{marginTop:8}}>
              <input ref={fileInputRef} type="file" accept=".pdf,.txt,.md" onChange={handleResumeUpload} style={{display:"none"}} />
              <button className="resume-btn" onClick={()=>fileInputRef.current?.click()} disabled={!sessionId||starting||voice.voiceActive}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                {resumeFile ? resumeFile.name : "Upload resume"}
              </button>
              {resumeStatus && <div className={`resume-status${resumeStatus.startsWith("✓")?" ok":resumeStatus==="uploading"?" loading":" err"}`}>{resumeStatus}</div>}
            </div>
          </div>

          <div>
            <div className="section-label">Session stats</div>
            <div className="stat-grid" style={{marginTop:8}}>
              <div className="stat-card"><div className="stat-val green">{effectiveAnswered}</div><div className="stat-label">Answered</div></div>
              <div className="stat-card"><div className="stat-val dim">{duration}m</div><div className="stat-label">Duration</div></div>
              <div className="stat-card"><div className="stat-val dim">{effectiveQCount}</div><div className="stat-label">Questions</div></div>
              <div className="stat-card"><div className="stat-val amber" style={{fontSize:13}}>{interviewCompleted?"Done ✓":"Live"}</div><div className="stat-label">Status</div></div>
            </div>
          </div>

          <div>
            <div className="section-label">Topic coverage</div>
            <div style={{marginTop:8}}>
              {role.topics.map((t,i) => (
                <div key={t} className="topic-row">
                  <span className="topic-name">{t}</span>
                  <div className="topic-bar-bg"><div className="topic-bar" style={{width:`${topicCoverage[i]}%`}}/></div>
                  <span className="topic-pct">{topicCoverage[i]}%</span>
                </div>
              ))}
            </div>
          </div>

          {!voice.voiceActive && (
            <button className="voice-start-btn" onClick={() => voice.startVoice(role.label, difficulty)} disabled={starting}>
              🎙️ Start Voice Interview
            </button>
          )}

          <button className="new-btn" onClick={() => startSession(role.label, difficulty)} disabled={starting||voice.voiceActive}>
            {starting ? "Starting..." : "+ New session"}
          </button>
        </div>

        {/* ── Center — Chat or Voice ── */}
        {voice.voiceActive ? (
          <VoicePanel {...voice} />
        ) : (
          <div className="chat-area">
            <div className="chat-header">
              <div>
                <div className="chat-title">Mock interview session</div>
                <div className="chat-sub">Question {questionCount} · {difficulty}-level {role.label}</div>
              </div>
              <div className="header-badges">
                <span className="badge badge-role">{role.id.toUpperCase()}</span>
                <span className="badge badge-diff">{difficulty}</span>
                {interviewCompleted
                  ? <span className="badge badge-done">Completed ✓</span>
                  : <span className="badge badge-q">Q{questionCount}</span>
                }
              </div>
            </div>

            <div className="messages">
              {starting && (
                <div className="starting-msg">
                  <div className="thinking-dots"><span/><span/><span/></div>
                  Starting your {difficulty} {role.label} session...
                </div>
              )}
              {messages.map((msg,i) => (
                <div key={i} className={`msg${msg.role==="user"?" user":""}`}>
                  <div className={`avatar${msg.role==="user"?" user":" ai"}`}>{msg.role==="user"?"You":"AI"}</div>
                  <div className={`bubble${msg.role==="user"?" user":" ai"}`}>{msg.content}</div>
                </div>
              ))}
              {loading && (
                <div className="msg">
                  <div className="avatar ai">AI</div>
                  <div className="bubble ai"><div className="thinking-dots"><span/><span/><span/></div></div>
                </div>
              )}
              <div ref={messagesEndRef}/>
            </div>

            <div className="input-area">
              <div className="input-wrap">
                <textarea ref={textareaRef} value={input} onChange={handleInput} onKeyDown={handleKeyDown}
                  placeholder={interviewCompleted ? "Interview complete — start a new session!" : "Type your answer... (Shift+Enter for new line)"}
                  disabled={loading||starting||interviewCompleted||evaluating}/>
                <div className="input-footer">
                  <span className="char-count">{input.length} / 800</span>
                  <button className="send-btn" onClick={sendMessage} disabled={loading||starting||!input.trim()||interviewCompleted||evaluating}>
                    Send <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Right Panel ── */}
        <div className="right-panel">

          {/* DURING interview */}
          {!interviewCompleted && !evaluating && (
            <>
              <div>
                <div className="section-label">Interview progress</div>
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--text2)",marginBottom:6}}>
                    <span>Questions completed</span>
                    <span style={{fontFamily:"'DM Mono',monospace",color:"var(--text3)"}}>{progress} / 10</span>
                  </div>
                  <div className="progress-bar-bg">
                    <div className="progress-bar" style={{width:`${(progress/10)*100}%`}}/>
                  </div>
                </div>
              </div>

              <div>
                <div className="section-label">Status</div>
                <div style={{marginTop:10}}>
                  <div className="weak-tag amber">Interview in progress...</div>
                  <div className="weak-tag amber">Score & feedback appear after completion</div>
                </div>
              </div>

              <div>
                <div className="section-label">Topic coverage</div>
                <div style={{marginTop:10}}>
                  {role.topics.map((t,i) => (
                    <div key={t} className="criteria-row">
                      <div className="criteria-header">
                        <span className="criteria-name">{t}</span>
                        <span className="criteria-score">{topicCoverage[i]}%</span>
                      </div>
                      <div className="criteria-bar-bg">
                        <div className="criteria-bar" style={{width:`${topicCoverage[i]}%`,background:"var(--accent)"}}/>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* EVALUATING spinner */}
          {evaluating && (
            <div className="evaluating-state">
              <div className="eval-spinner"/>
              <div>Evaluating your performance...</div>
              <div style={{fontSize:11}}>AI is reviewing all your answers</div>
            </div>
          )}

          {/* AFTER interview — real evaluation */}
          {interviewCompleted && evaluation && !evaluating && (
            <>
              <div>
                <div className="section-label">Final score</div>
                <div className="score-ring-wrap">
                  <div className="score-ring">
                    <svg width="90" height="90" viewBox="0 0 90 90">
                      <circle cx="45" cy="45" r="36" fill="none" stroke="var(--surface3)" strokeWidth="7"/>
                      <circle cx="45" cy="45" r="36" fill="none" stroke={scoreColor} strokeWidth="7"
                        strokeDasharray={circleLen}
                        strokeDashoffset={circleLen - (evalScore/100)*circleLen}
                        strokeLinecap="round"
                        style={{transition:"stroke-dashoffset .8s ease, stroke .3s"}}
                      />
                    </svg>
                    <div className="score-center">
                      <div className="score-num" style={{color:scoreColor}}>{evalScore}</div>
                      <div className="score-max">/100</div>
                    </div>
                  </div>
                  <div style={{fontSize:12,color:"var(--text3)"}}>
                    {evalScore>=80?"Above average":evalScore>=60?"On track":"Needs work"} for {difficulty.toLowerCase()}-level
                  </div>
                </div>
              </div>

              <div>
                <div className="section-label">Evaluation breakdown</div>
                <div style={{marginTop:10}}>
                  {[
                    {name:"Communication",   score:evaluation.communication,   color:"var(--accent)"},
                    {name:"Technical depth", score:evaluation.technical_depth, color:"var(--amber)"},
                    {name:"Problem solving", score:evaluation.problem_solving, color:"var(--green)"},
                  ].map(c => (
                    <div key={c.name} className="criteria-row">
                      <div className="criteria-header">
                        <span className="criteria-name">{c.name}</span>
                        <span className="criteria-score">{c.score}</span>
                      </div>
                      <div className="criteria-bar-bg">
                        <div className="criteria-bar" style={{width:`${c.score}%`,background:c.color}}/>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {evaluation.strengths?.length > 0 && (
                <div>
                  <div className="section-label">Strengths</div>
                  <div style={{marginTop:10}}>
                    {evaluation.strengths.map((s,i) => (
                      <div key={i} className="weak-tag green">{s}</div>
                    ))}
                  </div>
                </div>
              )}

              {evaluation.weak_areas?.length > 0 && (
                <div>
                  <div className="section-label">Areas to improve</div>
                  <div style={{marginTop:10}}>
                    {evaluation.weak_areas.map((w,i) => (
                      <div key={i} className="weak-tag amber">{w}</div>
                    ))}
                  </div>
                </div>
              )}

              {evaluation.summary && (
                <div>
                  <div className="section-label">Interviewer summary</div>
                  <div className="summary-box">{evaluation.summary}</div>
                </div>
              )}
            </>
          )}

          {/* Past sessions — real from DB */}
          <div>
            <div className="section-label">Past sessions</div>
            <div style={{marginTop:10}}>
              {history.length === 0 ? (
                <div style={{fontSize:12,color:"var(--text3)",padding:"8px 0"}}>No completed sessions yet</div>
              ) : (
                history.slice(0,5).map((h,i) => {
                  const sc = h.overall_score
                  const color = sc >= 80 ? "var(--green)" : sc >= 60 ? "var(--amber)" : "var(--red)"
                  return (
                    <div key={i} className="history-item" style={{position:"relative"}}>
                      <div onClick={() => setSelectedHistory(h)} style={{cursor:"pointer"}}>
                        <span className="history-score" style={{color}}>{sc ?? "—"}</span>
                        <div className="history-role">{h.role}</div>
                        <div className="history-meta">{formatDate(h.completed_at)} · {h.difficulty}</div>
                      </div>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          await fetch(`${API_URL}/session/${h.session_id}`, { method: "DELETE" })
                          fetchHistory()
                        }}
                        style={{
                          position:"absolute", top:6, right:6,
                          width:18, height:18, borderRadius:4,
                          border:"none", background:"transparent",
                          color:"var(--text3)", cursor:"pointer",
                          fontSize:14, display:"flex", alignItems:"center", justifyContent:"center",
                          lineHeight:1
                        }}
                        title="Delete session"
                      >×</button>
                    </div>
                  )
                })
              )}
            </div>
          </div>

        </div>
      </div>

      <HistoryModal
        session={selectedHistory}
        onClose={() => setSelectedHistory(null)}
      />
    </>
  )
}

const STYLES = `
.app { display:grid; grid-template-columns:252px 1fr 272px; height:100vh; overflow:hidden; }
.sidebar { background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; padding:18px 14px; gap:18px; overflow-y:auto; overflow-x:hidden; }
.sidebar::-webkit-scrollbar { width:0; }
.logo { display:flex; align-items:center; gap:10px; padding-bottom:14px; border-bottom:1px solid var(--border); flex-shrink:0; }
.logo-icon { width:30px; height:30px; border-radius:8px; background:linear-gradient(135deg,var(--accent),var(--accent2)); display:flex; align-items:center; justify-content:center; font-size:15px; flex-shrink:0; }
.logo-text { font-size:14px; font-weight:600; letter-spacing:-0.3px; }
.logo-text span { color:var(--accent); }
.section-label { font-size:10px; font-weight:600; letter-spacing:1.2px; color:var(--text3); text-transform:uppercase; margin-bottom:6px; }
.role-btn { width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1px solid var(--border); background:transparent; color:var(--text2); font-family:inherit; font-size:13px; text-align:left; cursor:pointer; transition:all .15s; display:flex; align-items:center; gap:8px; }
.role-btn:hover { background:var(--surface2); color:var(--text); border-color:var(--border2); }
.role-btn.active { background:var(--surface3); color:var(--accent); border-color:rgba(79,124,255,0.35); }
.role-dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex-shrink:0; }
.diff-row { display:flex; gap:5px; }
.diff-btn { flex:1; padding:7px 2px; border-radius:var(--radius-sm); border:1px solid var(--border); background:transparent; color:var(--text3); font-family:inherit; font-size:11px; font-weight:500; cursor:pointer; text-align:center; transition:all .15s; }
.diff-btn:hover { border-color:var(--border2); color:var(--text2); }
.diff-btn.active { border-color:rgba(79,124,255,0.5); background:rgba(79,124,255,0.1); color:var(--accent); }
.stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
.stat-card { background:var(--surface2); border-radius:var(--radius-sm); padding:10px 11px; border:1px solid var(--border); }
.stat-val { font-size:21px; font-weight:600; font-family:'DM Mono',monospace; letter-spacing:-1px; }
.stat-val.green { color:var(--green); } .stat-val.amber { color:var(--amber); }
.stat-val.dim { font-size:17px; color:var(--text2); }
.stat-label { font-size:11px; color:var(--text3); margin-top:2px; }
.topic-row { display:flex; align-items:center; gap:8px; font-size:12px; margin-bottom:7px; }
.topic-name { color:var(--text2); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.topic-bar-bg { flex:2; height:3px; background:var(--surface3); border-radius:3px; overflow:hidden; }
.topic-bar { height:100%; border-radius:3px; background:var(--accent); transition:width .6s ease; }
.topic-pct { color:var(--text3); font-family:'DM Mono',monospace; font-size:11px; min-width:28px; text-align:right; }
.add-role-btn { width:100%; padding:8px 12px; border-radius:var(--radius-sm); border:1px dashed var(--border2); background:transparent; color:var(--text3); font-family:inherit; font-size:12px; cursor:pointer; transition:all .15s; text-align:center; }
.add-role-btn:hover { border-color:rgba(79,124,255,0.4); color:var(--accent); background:rgba(79,124,255,0.05); }
.add-role-btn:disabled { opacity:.4; cursor:not-allowed; }
.add-role-wrap { display:flex; gap:4px; align-items:center; }
.add-role-input { flex:1; padding:8px 10px; border-radius:var(--radius-sm); border:1px solid rgba(79,124,255,0.35); background:var(--surface2); color:var(--text); font-family:inherit; font-size:12px; outline:none; }
.add-role-input:focus { border-color:var(--accent); }
.add-role-input::placeholder { color:var(--text3); }
.add-role-confirm { width:28px; height:28px; border-radius:6px; border:1px solid rgba(34,197,94,0.4); background:rgba(34,197,94,0.1); color:var(--green); font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .15s; }
.add-role-confirm:hover { background:rgba(34,197,94,0.2); }
.add-role-confirm:disabled { opacity:.3; cursor:not-allowed; }
.add-role-cancel { width:28px; height:28px; border-radius:6px; border:1px solid var(--border); background:transparent; color:var(--text3); font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .15s; }
.add-role-cancel:hover { color:var(--red); border-color:rgba(239,68,68,0.3); }
.role-remove-btn { width:24px; height:24px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--text3); font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .15s; flex-shrink:0; }
.role-remove-btn:hover { color:var(--red); border-color:rgba(239,68,68,0.3); background:rgba(239,68,68,0.08); }
.resume-btn { width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1px solid var(--border); background:transparent; color:var(--text2); font-family:inherit; font-size:12px; cursor:pointer; transition:all .15s; display:flex; align-items:center; gap:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.resume-btn:hover { background:var(--surface2); border-color:var(--border2); color:var(--text); }
.resume-btn:disabled { opacity:.4; cursor:not-allowed; }
.resume-status { font-size:11px; margin-top:5px; padding:4px 8px; border-radius:6px; }
.resume-status.ok { color:var(--green); background:rgba(34,197,94,0.08); }
.resume-status.loading { color:var(--amber); background:rgba(245,158,11,0.08); }
.resume-status.err { color:var(--red); background:rgba(239,68,68,0.08); }
.voice-start-btn { padding:11px; border-radius:var(--radius-sm); border:1px solid rgba(34,197,94,0.35); background:rgba(34,197,94,0.08); color:var(--green); font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; transition:all .15s; display:flex; align-items:center; justify-content:center; gap:7px; flex-shrink:0; }
.voice-start-btn:hover { background:rgba(34,197,94,0.15); border-color:rgba(34,197,94,0.5); }
.voice-start-btn:disabled { opacity:.4; cursor:not-allowed; }
.new-btn { padding:10px; border-radius:var(--radius-sm); border:1px dashed var(--border2); background:transparent; color:var(--text3); font-family:inherit; font-size:13px; cursor:pointer; transition:all .15s; display:flex; align-items:center; justify-content:center; gap:6px; flex-shrink:0; }
.new-btn:hover { border-color:rgba(79,124,255,0.4); color:var(--accent); background:rgba(79,124,255,0.05); }
.new-btn:disabled { opacity:.4; cursor:not-allowed; }
.chat-area { display:flex; flex-direction:column; background:var(--bg); overflow:hidden; }
.chat-header { padding:14px 22px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
.chat-title { font-size:14px; font-weight:500; }
.chat-sub { font-size:12px; color:var(--text3); margin-top:1px; }
.header-badges { display:flex; gap:7px; align-items:center; }
.badge { padding:3px 9px; border-radius:20px; font-size:11px; font-weight:500; }
.badge-role { background:rgba(79,124,255,0.12); color:var(--accent); border:1px solid rgba(79,124,255,0.25); }
.badge-diff { background:rgba(245,158,11,0.12); color:var(--amber); border:1px solid rgba(245,158,11,0.25); }
.badge-q { background:var(--surface2); color:var(--text2); border:1px solid var(--border); }
.badge-done { background:rgba(34,197,94,0.12); color:var(--green); border:1px solid rgba(34,197,94,0.25); }
.messages { flex:1; overflow-y:auto; padding:22px; display:flex; flex-direction:column; gap:14px; }
.messages::-webkit-scrollbar { width:4px; }
.messages::-webkit-scrollbar-track { background:transparent; }
.messages::-webkit-scrollbar-thumb { background:var(--surface3); border-radius:4px; }
.msg { display:flex; gap:10px; }
.msg.user { flex-direction:row-reverse; }
.avatar { width:30px; height:30px; border-radius:9px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; }
.avatar.ai { background:linear-gradient(135deg,var(--accent),var(--accent2)); font-size:13px; }
.avatar.user { background:var(--surface3); color:var(--text2); }
.bubble { max-width:74%; padding:11px 15px; border-radius:14px; font-size:14px; line-height:1.65; }
.bubble.ai { background:var(--surface); border:1px solid var(--border); border-top-left-radius:4px; color:var(--text); }
.bubble.user { background:var(--accent); color:#fff; border-top-right-radius:4px; }
.thinking-dots span { display:inline-block; width:5px; height:5px; border-radius:50%; background:var(--text3); margin:0 2px; animation:blink 1.2s infinite; }
.thinking-dots span:nth-child(2) { animation-delay:.2s; }
.thinking-dots span:nth-child(3) { animation-delay:.4s; }
@keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }
.starting-msg { display:flex; align-items:center; gap:10px; color:var(--text3); font-size:13px; padding:20px 0; }
.input-area { padding:14px 22px; border-top:1px solid var(--border); flex-shrink:0; }
.input-wrap { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:11px 15px; transition:border-color .15s; }
.input-wrap:focus-within { border-color:rgba(79,124,255,0.45); }
textarea { width:100%; background:transparent; border:none; outline:none; color:var(--text); font-family:inherit; font-size:14px; resize:none; line-height:1.6; min-height:52px; max-height:110px; }
textarea::placeholder { color:var(--text3); }
textarea:disabled { opacity:.5; }
.input-footer { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
.char-count { font-size:12px; color:var(--text3); font-family:'DM Mono',monospace; }
.send-btn { padding:7px 16px; border-radius:var(--radius-sm); background:var(--accent); border:none; color:#fff; font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; transition:opacity .15s; display:flex; align-items:center; gap:5px; }
.send-btn:hover:not(:disabled) { opacity:.85; }
.send-btn:disabled { opacity:.4; cursor:not-allowed; }
.right-panel { background:var(--surface); border-left:1px solid var(--border); display:flex; flex-direction:column; padding:18px 14px; gap:18px; overflow-y:auto; }
.right-panel::-webkit-scrollbar { width:0; }
.score-ring-wrap { display:flex; flex-direction:column; align-items:center; gap:7px; margin-top:10px; }
.score-ring { position:relative; width:90px; height:90px; }
.score-ring svg { transform:rotate(-90deg); }
.score-center { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); text-align:center; }
.score-num { font-size:24px; font-weight:600; font-family:'DM Mono',monospace; letter-spacing:-1px; }
.score-max { font-size:10px; color:var(--text3); }
.criteria-row { display:flex; flex-direction:column; gap:4px; margin-bottom:8px; }
.criteria-header { display:flex; justify-content:space-between; font-size:12px; }
.criteria-name { color:var(--text2); } .criteria-score { color:var(--text3); font-family:'DM Mono',monospace; }
.criteria-bar-bg { height:3px; background:var(--surface3); border-radius:3px; overflow:hidden; }
.criteria-bar { height:100%; border-radius:3px; transition:width .6s ease; }
.weak-tag { padding:7px 10px; border-radius:7px; font-size:12px; margin-bottom:6px; line-height:1.5; }
.weak-tag.red   { background:rgba(239,68,68,0.1);  border:1px solid rgba(239,68,68,0.25);  color:#f87171; }
.weak-tag.amber { background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.25); color:#fbbf24; }
.weak-tag.green { background:rgba(34,197,94,0.1);  border:1px solid rgba(34,197,94,0.25);  color:#86efac; }
.progress-bar-bg { height:6px; background:var(--surface3); border-radius:6px; overflow:hidden; margin-top:8px; }
.progress-bar { height:100%; border-radius:6px; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .6s ease; }
.evaluating-state { display:flex; flex-direction:column; align-items:center; gap:12px; padding:30px 0; color:var(--text3); font-size:13px; text-align:center; }
.eval-spinner { width:32px; height:32px; border:3px solid var(--surface3); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.summary-box { font-size:13px; line-height:1.7; color:var(--text2); background:var(--surface2); padding:12px; border-radius:10px; border:1px solid var(--border); margin-top:10px; }
.history-item { padding:9px 11px; border-radius:var(--radius-sm); background:var(--surface2); border:1px solid var(--border); cursor:pointer; transition:border-color .15s; margin-bottom:7px; }
.history-item:hover { border-color:var(--border2); }
.history-role { font-size:12px; font-weight:500; color:var(--text2); }
.history-meta { font-size:11px; color:var(--text3); margin-top:2px; }
.history-score { float:right; font-size:13px; font-weight:600; font-family:'DM Mono',monospace; }
`