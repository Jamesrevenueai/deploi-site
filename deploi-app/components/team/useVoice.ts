'use client'
/**
 * Voice chat in the browser: speech-to-text through the Web Speech API (where the browser has it) and
 * the agent's reply read aloud through speechSynthesis. Nothing is recorded or uploaded: the browser
 * transcribes, and only the text reaches Deploi. Browsers without the API get text only.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type RecognitionLike = { lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error?: string }) => void) | null; start(): void; stop(): void; abort(): void }
type RecognitionCtor = new () => RecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useVoice(onTranscript: (text: string) => void) {
  const [supported, setSupported] = useState(false)
  const [canSpeak, setCanSpeak] = useState(false)
  const [listening, setListening] = useState(false)
  const [speakReplies, setSpeakReplies] = useState(false)
  const rec = useRef<RecognitionLike | null>(null)
  const handler = useRef(onTranscript)
  handler.current = onTranscript

  useEffect(() => {
    setSupported(recognitionCtor() !== null)
    setCanSpeak(typeof window !== 'undefined' && 'speechSynthesis' in window)
  }, [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const r = new Ctor()
    r.lang = navigator.language || 'en-US'
    r.interimResults = false
    r.continuous = false
    r.onresult = e => { const t = Array.from(e.results).map(x => x[0]?.transcript ?? '').join(' ').trim(); if (t) handler.current(t) }
    r.onend = () => { setListening(false); rec.current = null }
    r.onerror = () => { setListening(false); rec.current = null }
    rec.current = r
    setListening(true)
    r.start()
  }, [])
  const stop = useCallback(() => { rec.current?.stop(); setListening(false) }, [])
  const speak = useCallback((text: string) => {
    if (!speakReplies || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
  }, [speakReplies])
  useEffect(() => () => { rec.current?.abort(); if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel() }, [])

  return { supported, canSpeak, listening, start, stop, speak, speakReplies, setSpeakReplies }
}
