import { useEffect, useRef, useMemo } from "react"

const PHASE_CONFIG = {
  idle:       { label: "Ready",        color1: "#555c70", color2: "#555c70", icon: "ready" },
  starting:   { label: "Connecting...", color1: "#f59e0b", color2: "#f97316", icon: "starting" },
  speaking:   { label: "AI is speaking", color1: "#4f7cff", color2: "#7c5cfc", icon: "speaking" },
  listening:  { label: "Listening",    color1: "#22c55e", color2: "#06b6d4", icon: "listening" },
  processing: { label: "Thinking...",  color1: "#a78bfa", color2: "#7c5cfc", icon: "processing" },
}

export default function VoicePanel({ voicePhase, transcript, interimText, voiceMessages, voiceError, volumeLevel, voiceQuestionCount, voiceAnswered, stopVoice }) {
  const scrollRef = useRef(null)
  const canvasRef = useRef(null)
  const animRef = useRef(null)
  const phaseRef = useRef(voicePhase)
  const volRef = useRef(volumeLevel)

  useEffect(() => { phaseRef.current = voicePhase }, [voicePhase])
  useEffect(() => { volRef.current = volumeLevel }, [volumeLevel])
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: "smooth" }) }, [voiceMessages])

  const cfg = PHASE_CONFIG[voicePhase] || PHASE_CONFIG.idle
  const isListening = voicePhase === "listening"
  const isSpeaking = voicePhase === "speaking"
  const isProcessing = voicePhase === "processing"

  // Canvas orb animation
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    const dpr = window.devicePixelRatio || 1
    const size = 280
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = size + "px"
    canvas.style.height = size + "px"
    ctx.scale(dpr, dpr)
    const cx = size / 2, cy = size / 2
    let t = 0

    const draw = () => {
      t += 0.015
      const phase = phaseRef.current
      const vol = volRef.current
      const pc = PHASE_CONFIG[phase] || PHASE_CONFIG.idle
      ctx.clearRect(0, 0, size, size)

      // Outer glow rings
      const ringCount = 4
      for (let i = ringCount; i >= 1; i--) {
        const pulse = phase === "listening"
          ? 1 + vol * 0.4 * i
          : phase === "speaking"
            ? 1 + Math.sin(t * 2 + i) * 0.08 * i
            : 1 + Math.sin(t + i * 0.5) * 0.03 * i
        const r = (28 + i * 16) * pulse
        const alpha = phase === "idle" ? 0.02 : (0.12 - i * 0.025) * (phase === "listening" ? 1 + vol * 0.5 : 1)
        const grad = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r)
        grad.addColorStop(0, hexAlpha(pc.color1, alpha * 0.8))
        grad.addColorStop(0.6, hexAlpha(pc.color1, alpha * 0.3))
        grad.addColorStop(1, hexAlpha(pc.color2, 0))
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()
      }

      // Main orb
      const orbBase = 38
      const orbPulse = phase === "listening"
        ? 1 + vol * 0.25
        : phase === "speaking"
          ? 1 + Math.sin(t * 3) * 0.06
          : phase === "processing"
            ? 1 + Math.sin(t * 2) * 0.04
            : 1
      const orbR = orbBase * orbPulse

      // Orb gradient
      const orbGrad = ctx.createRadialGradient(cx - orbR * 0.2, cy - orbR * 0.2, orbR * 0.1, cx, cy, orbR)
      orbGrad.addColorStop(0, hexAlpha(pc.color1, 0.95))
      orbGrad.addColorStop(0.5, hexAlpha(pc.color2, 0.7))
      orbGrad.addColorStop(1, hexAlpha(pc.color2, 0.3))
      ctx.beginPath()
      ctx.arc(cx, cy, orbR, 0, Math.PI * 2)
      ctx.fillStyle = orbGrad
      ctx.fill()

      // Inner bright core
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR * 0.6)
      coreGrad.addColorStop(0, "rgba(255,255,255,0.25)")
      coreGrad.addColorStop(1, "rgba(255,255,255,0)")
      ctx.beginPath()
      ctx.arc(cx, cy, orbR * 0.6, 0, Math.PI * 2)
      ctx.fillStyle = coreGrad
      ctx.fill()

      // Waveform ring (when listening or speaking)
      if (phase === "listening" || phase === "speaking") {
        const waveR = orbR + 14
        const points = 64
        const amplitude = phase === "listening" ? vol * 12 + 2 : 3 + Math.sin(t * 2) * 2
        ctx.beginPath()
        for (let i = 0; i <= points; i++) {
          const angle = (i / points) * Math.PI * 2
          const wave = Math.sin(angle * 6 + t * 4) * amplitude
            + Math.sin(angle * 3 - t * 2) * amplitude * 0.5
          const pr = waveR + wave
          const px = cx + Math.cos(angle) * pr
          const py = cy + Math.sin(angle) * pr
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.strokeStyle = hexAlpha(pc.color1, 0.4)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Processing spinner ring
      if (phase === "processing") {
        const spinR = orbR + 16
        ctx.beginPath()
        ctx.arc(cx, cy, spinR, t * 2, t * 2 + Math.PI * 1.2)
        ctx.strokeStyle = hexAlpha(pc.color1, 0.5)
        ctx.lineWidth = 2
        ctx.lineCap = "round"
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(cx, cy, spinR + 8, -t * 1.5, -t * 1.5 + Math.PI * 0.8)
        ctx.strokeStyle = hexAlpha(pc.color2, 0.3)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Starting pulsing dot ring
      if (phase === "starting") {
        const dots = 8
        for (let i = 0; i < dots; i++) {
          const angle = (i / dots) * Math.PI * 2 + t * 2
          const dr = orbR + 20
          const dx = cx + Math.cos(angle) * dr
          const dy = cy + Math.sin(angle) * dr
          const dotAlpha = 0.3 + Math.sin(t * 3 + i) * 0.3
          ctx.beginPath()
          ctx.arc(dx, dy, 2.5, 0, Math.PI * 2)
          ctx.fillStyle = hexAlpha(pc.color1, dotAlpha)
          ctx.fill()
        }
      }

      animRef.current = requestAnimationFrame(draw)
    }

    animRef.current = requestAnimationFrame(draw)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [])

  const lastAiMsg = useMemo(() => {
    for (let i = voiceMessages.length - 1; i >= 0; i--) {
      if (voiceMessages[i].role === "assistant") return voiceMessages[i].content
    }
    return ""
  }, [voiceMessages])

  return (
    <div className="vp-root">
      <style>{VP_STYLES}</style>

      {/* Top bar */}
      <div className="vp-topbar">
        <div className="vp-topbar-left">
          <div className="vp-dot" style={{ background: cfg.color1 }} />
          <span className="vp-topbar-label">Voice Interview</span>
          <span className="vp-topbar-meta">Q{voiceQuestionCount} · {voiceAnswered} answered</span>
        </div>
        <button className="vp-end-btn" onClick={stopVoice}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          End
        </button>
      </div>

      {/* Center orb area */}
      <div className="vp-center">
        <canvas ref={canvasRef} className="vp-canvas" />
        <div className="vp-phase-label" style={{ color: cfg.color1 }}>{cfg.label}</div>

        {/* Live transcript */}
        {isListening && (transcript || interimText) && (
          <div className="vp-transcript">
            {transcript && <span className="vp-transcript-final">{transcript} </span>}
            {interimText && <span className="vp-transcript-interim">{interimText}</span>}
          </div>
        )}

        {/* AI's last message while speaking */}
        {isSpeaking && lastAiMsg && (
          <div className="vp-ai-text">{lastAiMsg.length > 200 ? lastAiMsg.slice(0, 200) + "..." : lastAiMsg}</div>
        )}

        {voiceError && <div className="vp-error">{voiceError}</div>}
      </div>

      {/* Bottom message log */}
      <div className="vp-log">
        {voiceMessages.slice(-4).map((m, i) => (
          <div key={i} className={`vp-log-msg ${m.role}`}>
            <span className="vp-log-role">{m.role === "user" ? "You" : "AI"}</span>
            <span className="vp-log-text">{m.content.length > 120 ? m.content.slice(0, 120) + "..." : m.content}</span>
          </div>
        ))}
        <div ref={scrollRef} />
      </div>
    </div>
  )
}

function hexAlpha(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

const VP_STYLES = `
.vp-root {
  display: flex; flex-direction: column; height: 100%;
  background: radial-gradient(ellipse at 50% 40%, #131730 0%, #0a0c14 70%);
  overflow: hidden; position: relative;
}
.vp-topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 22px; flex-shrink: 0; position: relative; z-index: 2;
}
.vp-topbar-left { display: flex; align-items: center; gap: 10px; }
.vp-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 8px currentColor; }
.vp-topbar-label { font-size: 13px; font-weight: 500; color: var(--text); }
.vp-topbar-meta { font-size: 11px; color: var(--text3); margin-left: 4px; }
.vp-end-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 14px; border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04);
  color: var(--text2); font-family: inherit; font-size: 12px; font-weight: 500;
  cursor: pointer; transition: all .2s;
}
.vp-end-btn:hover { background: rgba(239,68,68,0.12); color: #f87171; border-color: rgba(239,68,68,0.3); }

.vp-center {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 20px; position: relative; z-index: 1; padding: 0 30px;
}
.vp-canvas { display: block; }
.vp-phase-label {
  font-size: 14px; font-weight: 500; letter-spacing: 0.8px;
  text-transform: uppercase; opacity: 0.9;
  animation: vpFadeIn 0.3s ease;
}
.vp-transcript {
  max-width: 520px; text-align: center; padding: 14px 22px;
  background: rgba(255,255,255,0.04); backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.06); border-radius: 16px;
  font-size: 15px; line-height: 1.6; animation: vpSlideUp 0.3s ease;
}
.vp-transcript-final { color: var(--text); }
.vp-transcript-interim { color: var(--text3); font-style: italic; }
.vp-ai-text {
  max-width: 480px; text-align: center; font-size: 14px; line-height: 1.65;
  color: var(--text2); padding: 12px 20px;
  background: rgba(79,124,255,0.04); border: 1px solid rgba(79,124,255,0.08);
  border-radius: 14px; backdrop-filter: blur(8px); animation: vpSlideUp 0.3s ease;
}
.vp-error {
  font-size: 13px; color: var(--red); padding: 8px 16px;
  background: rgba(239,68,68,0.08); border-radius: 10px;
  border: 1px solid rgba(239,68,68,0.15);
}

.vp-log {
  flex-shrink: 0; max-height: 140px; overflow-y: auto;
  padding: 12px 22px; display: flex; flex-direction: column; gap: 6px;
  border-top: 1px solid rgba(255,255,255,0.04); position: relative; z-index: 2;
}
.vp-log::-webkit-scrollbar { width: 0; }
.vp-log-msg {
  display: flex; gap: 8px; font-size: 12px; line-height: 1.5;
  padding: 6px 10px; border-radius: 8px; animation: vpFadeIn 0.3s ease;
}
.vp-log-msg.user { background: rgba(79,124,255,0.06); }
.vp-log-msg.assistant { background: rgba(255,255,255,0.02); }
.vp-log-role {
  font-weight: 600; flex-shrink: 0; min-width: 24px;
  color: var(--text3); font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.5px; padding-top: 1px;
}
.vp-log-msg.user .vp-log-role { color: var(--accent); }
.vp-log-text { color: var(--text2); }

@keyframes vpFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes vpSlideUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`
