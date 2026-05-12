import { useState, useRef, useCallback, useEffect } from "react"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000"

// Audio detection thresholds
const SILENCE_THRESHOLD = 0.012   // RMS below this = silence
const SILENCE_DURATION  = 2000    // ms of silence before auto-send
const MIN_SPEECH_MS     = 800     // must have spoken at least this long
const MIN_SPEECH_RMS    = 0.018   // must have hit this volume to count as speech

export default function useVoiceInterview({ onComplete } = {}) {
  // idle | starting | speaking | listening | processing
  const [voicePhase,        setVoicePhase]        = useState("idle")
  const [voiceActive,       setVoiceActive]        = useState(false)
  const [transcript,        setTranscript]         = useState("")
  const [voiceMessages,     setVoiceMessages]      = useState([])
  const [voiceSessionId,    setVoiceSessionId]     = useState(null)
  const [voiceError,        setVoiceError]         = useState("")
  const [volumeLevel,       setVolumeLevel]        = useState(0)
  const [voiceQuestionCount,setVoiceQuestionCount] = useState(0)
  const [voiceAnswered,     setVoiceAnswered]      = useState(0)

  // Refs
  const audioCtxRef        = useRef(null)
  const analyserRef        = useRef(null)
  const streamRef          = useRef(null)
  const mediaRecorderRef   = useRef(null)
  const recordedChunksRef  = useRef([])
  const volumeRafRef       = useRef(null)
  const ttsAudioRef        = useRef(null)
  const abortRef           = useRef(false)
  const phaseRef           = useRef("idle")
  const sessionIdRef       = useRef(null)
  const roleRef            = useRef("")
  const diffRef            = useRef("")
  const speechStartedRef   = useRef(false)
  const speechStartTimeRef = useRef(0)
  const peakRmsRef         = useRef(0)
  const onCompleteRef      = useRef(onComplete)  // store callback in ref

  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  useEffect(() => { phaseRef.current = voicePhase }, [voicePhase])
  useEffect(() => { sessionIdRef.current = voiceSessionId }, [voiceSessionId])

  // --------------------------------------------------
  // Cleanup
  // --------------------------------------------------

  const cleanup = useCallback(() => {
    abortRef.current = true
    if (volumeRafRef.current)   cancelAnimationFrame(volumeRafRef.current)
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop() } catch {}
      mediaRecorderRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch {}
      audioCtxRef.current = null
    }
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current = null
    }
    window.speechSynthesis?.cancel()
  }, [])

  // --------------------------------------------------
  // TTS — browser only (Groq TTS deprecated)
  // --------------------------------------------------

  const speakBrowser = useCallback((text) => {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve()
      window.speechSynthesis.cancel()
      const utter    = new SpeechSynthesisUtterance(text.slice(0, 500))
      utter.rate     = 1.0
      utter.pitch    = 1.0
      utter.lang     = "en-US"
      utter.onend    = resolve
      utter.onerror  = resolve
      window.speechSynthesis.speak(utter)
    })
  }, [])

  const speakText = useCallback((text) => {
    return new Promise(async (resolve) => {
      if (abortRef.current) return resolve()
      setVoicePhase("speaking")
      phaseRef.current = "speaking"
      // Use browser TTS directly — no backend call needed
      await speakBrowser(text)
      resolve()
    })
  }, [speakBrowser])

  // --------------------------------------------------
  // Whisper STT
  // --------------------------------------------------

  const transcribeAudio = useCallback(async (audioBlob) => {
    const formData = new FormData()
    const ext      = audioBlob.type.includes("ogg") ? "ogg" :
                     audioBlob.type.includes("mp4") ? "mp4" : "webm"
    formData.append("file", audioBlob, `recording.${ext}`)
    const res  = await fetch(`${API_URL}/transcribe`, { method: "POST", body: formData })
    const data = await res.json()
    return data.transcript || ""
  }, [])

  // --------------------------------------------------
  // Start recording + silence detection
  // --------------------------------------------------

  const startListening = useCallback(async () => {
    if (abortRef.current) return
    setVoicePhase("listening")
    phaseRef.current = "listening"
    setTranscript("")
    recordedChunksRef.current  = []
    speechStartedRef.current   = false
    speechStartTimeRef.current = 0
    peakRmsRef.current         = 0

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      })
    } catch {
      setVoiceError("Microphone access denied. Please allow mic access and try again.")
      setVoicePhase("idle")
      phaseRef.current = "idle"
      return
    }

    if (abortRef.current) { stream.getTracks().forEach(t => t.stop()); return }
    streamRef.current = stream

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : ""

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    mediaRecorderRef.current = recorder
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data)
    }
    recorder.start(250)

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    audioCtxRef.current = audioCtx
    const source   = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.25
    source.connect(analyser)
    analyserRef.current = analyser

    const dataArray = new Float32Array(analyser.fftSize)
    let silentSince = null

    const checkVolume = () => {
      if (abortRef.current || phaseRef.current !== "listening") return
      analyser.getFloatTimeDomainData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i]
      const rms = Math.sqrt(sum / dataArray.length)
      setVolumeLevel(Math.min(1, rms * 8))

      if (rms > MIN_SPEECH_RMS) {
        if (!speechStartedRef.current) {
          speechStartedRef.current   = true
          speechStartTimeRef.current = Date.now()
        }
        peakRmsRef.current = Math.max(peakRmsRef.current, rms)
        silentSince = null
      } else {
        if (silentSince === null) silentSince = Date.now()
        const silentMs   = Date.now() - silentSince
        const spokenMs   = speechStartedRef.current ? Date.now() - speechStartTimeRef.current : 0
        const realSpeech = peakRmsRef.current > MIN_SPEECH_RMS * 1.5
        if (speechStartedRef.current && realSpeech && silentMs >= SILENCE_DURATION && spokenMs >= MIN_SPEECH_MS) {
          handleSilenceEnd()
          return
        }
      }
      volumeRafRef.current = requestAnimationFrame(checkVolume)
    }
    volumeRafRef.current = requestAnimationFrame(checkVolume)
  }, [])

  // --------------------------------------------------
  // Silence detected — transcribe + send to AI
  // --------------------------------------------------

  const handleSilenceEnd = useCallback(async () => {
    if (abortRef.current) return
    setVoicePhase("processing")
    phaseRef.current = "processing"
    setVolumeLevel(0)

    if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current)

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch {}
      audioCtxRef.current = null
    }

    await new Promise((resolve) => {
      const rec = mediaRecorderRef.current
      if (!rec || rec.state === "inactive") return resolve()
      rec.onstop = resolve
      try { rec.stop() } catch { resolve() }
    })

    const chunks = recordedChunksRef.current
    if (!chunks.length || abortRef.current) {
      if (!abortRef.current) startListening()
      return
    }

    const audioBlob = new Blob(chunks, { type: "audio/webm" })
    recordedChunksRef.current = []

    let transcribedText = ""
    try {
      transcribedText = await transcribeAudio(audioBlob)
    } catch (e) {
      console.error("Transcription error:", e)
    }

    const finalText = transcribedText.trim()
    if (!finalText || finalText.length < 2) {
      setTranscript("")
      if (!abortRef.current) setTimeout(() => startListening(), 300)
      return
    }

    setTranscript(finalText)
    setVoiceMessages(prev => [...prev, { role: "user", content: finalText }])

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          session_id: sessionIdRef.current,
          message:    finalText,
          role:       roleRef.current,
          difficulty: diffRef.current,
        }),
      })
      const data = await res.json()
      if (abortRef.current) return

      // ── Interview completed ──
      if (data.completed) {
        const endMsg = "That wraps up our interview! Your evaluation is ready — check the panel on the right. 🎯"
        setVoiceMessages(prev => {
          const finalMessages = [...prev, { role: "assistant", content: endMsg }]

          // Pass everything back to App.jsx via callback
          if (onCompleteRef.current) {
            onCompleteRef.current({
              messages:   finalMessages,
              evaluation: data.evaluation,
            })
          }
          return finalMessages
        })

        await speakText(endMsg)

        // Switch back to text view so user can scroll conversation
        cleanup()
        setVoiceActive(false)
        setVoicePhase("idle")
        phaseRef.current = "idle"
        return
      }

      // ── Normal response ──
      const aiText = data.response || "Let me rephrase that question."
      setVoiceMessages(prev => [...prev, { role: "assistant", content: aiText }])
      setVoiceAnswered(a => a + 1)
      setVoiceQuestionCount(q => q + 1)

      await speakText(aiText)
      if (!abortRef.current) startListening()

    } catch {
      if (!abortRef.current) {
        const errMsg = "Connection error. Let me try again."
        setVoiceMessages(prev => [...prev, { role: "assistant", content: errMsg }])
        await speakText(errMsg)
        startListening()
      }
    }
  }, [transcribeAudio, speakText, startListening, cleanup])

  // --------------------------------------------------
  // Start voice session
  // --------------------------------------------------

  const startVoice = useCallback(async (roleLabel, difficulty) => {
    abortRef.current = false
    roleRef.current  = roleLabel
    diffRef.current  = difficulty

    setVoiceActive(true)
    setVoicePhase("starting")
    phaseRef.current = "starting"
    setVoiceMessages([])
    setVoiceError("")
    setVoiceQuestionCount(0)
    setVoiceAnswered(0)
    setTranscript("")

    try {
      const data = await fetch(`${API_URL}/session/start`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ role: roleLabel, difficulty }),
      }).then(r => r.json())

      if (abortRef.current) return

      setVoiceSessionId(data.session_id)
      sessionIdRef.current = data.session_id
      setVoiceQuestionCount(1)

      const aiText = data.response
      setVoiceMessages([{ role: "assistant", content: aiText }])

      await speakText(aiText)
      if (!abortRef.current) startListening()

    } catch {
      setVoiceError("Could not connect to backend. Make sure FastAPI is running on port 8000.")
      setVoicePhase("idle")
      phaseRef.current = "idle"
      setVoiceActive(false)
    }
  }, [speakText, startListening])

  // --------------------------------------------------
  // Stop
  // --------------------------------------------------

  const stopVoice = useCallback(() => {
    cleanup()
    setVoiceActive(false)
    setVoicePhase("idle")
    phaseRef.current = "idle"
    setTranscript("")
    setVolumeLevel(0)
  }, [cleanup])

  useEffect(() => () => cleanup(), [cleanup])

  return {
    voiceActive, voicePhase, transcript,
    voiceMessages, voiceError, volumeLevel,
    voiceQuestionCount, voiceAnswered,
    startVoice, stopVoice,
  }
}