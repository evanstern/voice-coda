import type { ConversationSummary } from '@voice-coda/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLogger } from '~/lib/logger'

const log = createLogger('home')
import { useNavigate, useOutletContext, useParams } from 'react-router'
import { ChatMessage } from '../components/chat-message.js'
import { ConnectionHeader } from '../components/connection-header.js'
import { ConversationList } from '../components/conversation-list.js'
import { MicButton } from '../components/mic-button.js'
import { StatusIndicator } from '../components/status-indicator.js'
import { useAudioSocket } from '../hooks/use-audio-socket.js'
import { useSoundEffects } from '../hooks/use-sound-effects.js'
import { useVAD } from '../hooks/use-vad.js'
import { useWakeWord } from '../hooks/use-wake-word.js'
import { getClientTRPC } from '../trpc/client.js'

type InputMode = 'push-to-talk' | 'auto' | 'wake-word'

interface RootContext {
  health: { status: string; timestamp: string } | null
  wsConfig: { path: string; port: number | null } | null
  wakeWordConfig?: {
    path: string
    port: number | null
    enabled: boolean
  } | null
}

interface ConversationEntry {
  id: number
  userText: string
  userError?: string | null
  assistantText?: string | null
  assistantError?: string | null
  toolCalls?: Array<{ name: string; input: string; result: string }>
}

export function meta() {
  return [
    { title: 'Voice Assistant' },
    {
      name: 'description',
      content: 'Hands-free voice coding assistant',
    },
  ]
}

export default function Home() {
  const { health, wsConfig, wakeWordConfig } = useOutletContext<RootContext>()

  const wsUrl = useMemo(() => {
    if (typeof window === 'undefined' || !wsConfig) return null
    const isSecure = window.location.protocol === 'https:'
    const protocol = isSecure ? 'wss:' : 'ws:'
    // HTTPS implies a reverse proxy — always use same origin.
    // HTTP (bare-metal dev) may need the direct server port.
    const host =
      !isSecure && wsConfig.port != null
        ? `${window.location.hostname}:${wsConfig.port}`
        : window.location.host
    return `${protocol}//${host}${wsConfig.path}`
  }, [wsConfig])

  const wakeWordWsUrl = useMemo(() => {
    if (typeof window === 'undefined' || !wakeWordConfig?.enabled) return null
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host =
      wakeWordConfig.port != null
        ? `${window.location.hostname}:${wakeWordConfig.port}`
        : window.location.host
    return `${protocol}//${host}${wakeWordConfig.path}`
  }, [wakeWordConfig])

  const trpc = typeof window === 'undefined' ? null : getClientTRPC()

  const audio = useAudioSocket(wsUrl)
  const { play } = useSoundEffects()
  const phaseRef = useRef(audio.phase)
  const spaceDownRef = useRef(false)

  const [mode, setMode] = useState<InputMode>('push-to-talk')
  const isWakeWordMode = mode === 'wake-word'

  const wakeWord = useWakeWord(wakeWordWsUrl, isWakeWordMode)

  const toggleMode = useCallback(() => {
    setMode((m) => {
      if (m === 'push-to-talk') return 'auto'
      if (m === 'auto') return wakeWordWsUrl ? 'wake-word' : 'push-to-talk'
      if (audio.phase === 'recording') {
        audio.cancelRecording()
      }
      if (audio.phase === 'passive-listening') {
        audio.stopPassiveListening?.()
      }
      return 'push-to-talk'
    })
  }, [audio, wakeWordWsUrl])

  // Wake-word mode: set passive-listening phase and handle wake events
  useEffect(() => {
    if (!isWakeWordMode) return

    if (wakeWord.listening && audio.phase === 'idle') {
      audio.setPhase('passive-listening')
    }

    wakeWord.setOnWake(() => {
      log.info('wake word detected, starting active recording')
      play('commandAcknowledged')
      wakeWord.pause()
      audio.startRecording()
    })

    return () => wakeWord.setOnWake(null)
  }, [isWakeWordMode, wakeWord, audio, play])

  // Wake-word mode: return to passive listening after response completes
  useEffect(() => {
    if (!isWakeWordMode) return
    if (audio.phase === 'done') {
      const timer = setTimeout(() => {
        wakeWord.resume()
        audio.setPhase('passive-listening')
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [isWakeWordMode, audio.phase, wakeWord, audio.setPhase])

  // VAD for auto mode
  const vad = useVAD(
    mode === 'auto' && audio.phase === 'recording' ? audio.micStream : null,
    {
      silenceThreshold: 0.01,
      silenceTimeout: 1500,
    },
  )

  useEffect(() => {
    if (
      mode === 'auto' &&
      audio.connected &&
      (audio.phase === 'idle' || audio.phase === 'done') &&
      !audio.busy
    ) {
      audio.startPassiveListening()
    }
  }, [
    mode,
    audio.connected,
    audio.phase,
    audio.busy,
    audio.startPassiveListening,
  ])

  // In auto mode, stop recording when VAD detects silence after speech
  useEffect(() => {
    if (mode !== 'auto') return
    vad.setOnSpeechEnd(() => {
      if (audio.phase === 'recording') {
        log.debug('VAD detected speech end, sending')
        audio.stopRecording()
      }
    })
    return () => vad.setOnSpeechEnd(null)
  }, [mode, vad, audio])
  const scrollRef = useRef<HTMLDivElement>(null)
  const nextIdRef = useRef(1)

  // Conversation history (in-memory for current session)
  const [conversation, setConversation] = useState<ConversationEntry[]>([])
  const [pendingEntry, setPendingEntry] = useState<ConversationEntry | null>(
    null,
  )

  // Conversation management
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const params = useParams<{ conversationId?: string }>()
  const activeConversationId = params.conversationId ?? null
  const navigate = useNavigate()
  const isFirstMessageRef = useRef(true)

  // Fetch conversation list
  const refreshConversations = useCallback(async () => {
    if (!trpc) return
    try {
      const list = await trpc.conversations.list.query()
      setConversations(list)
    } catch (err) {
      log.error('failed to fetch conversations:', err)
    }
  }, [trpc])

  // Fetch on mount
  useEffect(() => {
    refreshConversations()
  }, [refreshConversations])

  // Create a new conversation and navigate to it
  const createNewConversation = useCallback(async () => {
    if (!trpc) return
    try {
      const conv = await trpc.conversations.create.mutate()
      refreshConversations()
      navigate(`/c/${conv.id}`)
    } catch (err) {
      log.error('failed to create conversation:', err)
    }
  }, [trpc, refreshConversations, navigate])

  // Load conversation data when activeConversationId changes (URL-driven)
  useEffect(() => {
    let cancelled = false

    if (activeConversationId && trpc) {
      const loadConversation = async () => {
        try {
          const data = await trpc.conversations.get.query({
            id: activeConversationId,
          })
          if (cancelled) return
          if (!data) {
            navigate('/', { replace: true })
            return
          }
          isFirstMessageRef.current = data.messages.length === 0

          // Convert persisted messages to ConversationEntry pairs
          const entries: ConversationEntry[] = []
          let entryId = 1
          const msgs = data.messages
          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i]
            if (!msg) continue
            if (msg.role === 'user') {
              const next = msgs[i + 1]
              const entry: ConversationEntry = {
                id: entryId++,
                userText: msg.content,
                userError: msg.error ?? null,
              }
              if (next?.role === 'assistant') {
                entry.assistantText = next.content
                entry.assistantError = next.error ?? null
                entry.toolCalls = next.toolCalls
                i++ // skip assistant message
              }
              entries.push(entry)
            }
          }
          setConversation(entries)
          setPendingEntry(null)
          nextIdRef.current = entryId
          if (audio.connected) {
            audio.sendConversation(
              activeConversationId,
              isFirstMessageRef.current,
            )
          }
        } catch (err) {
          log.error('failed to load conversation:', err)
          if (!cancelled) {
            navigate('/', { replace: true })
          }
        }
      }
      loadConversation()
    } else {
      // No active conversation — clear state
      setConversation([])
      setPendingEntry(null)
      nextIdRef.current = 1
      isFirstMessageRef.current = true
      if (audio.connected) {
        audio.sendConversation(null, true)
      }
    }

    // Close drawer when navigating
    setDrawerOpen(false)

    return () => {
      cancelled = true
    }
  }, [
    activeConversationId,
    trpc,
    navigate,
    audio.connected,
    audio.sendConversation,
  ])

  // Delete conversation
  const deleteConversation = useCallback(
    async (id: string) => {
      if (!trpc) return
      try {
        await trpc.conversations.delete.mutate({ id })
        if (activeConversationId === id) {
          navigate('/')
        }
        refreshConversations()
      } catch (err) {
        log.error('failed to delete conversation:', err)
      }
    },
    [trpc, activeConversationId, navigate, refreshConversations],
  )

  // Auto-create conversation on first recording if none active
  const handleStartRecording = useCallback(async () => {
    if (!activeConversationId && trpc) {
      try {
        const conv = await trpc.conversations.create.mutate()
        isFirstMessageRef.current = true
        audio.sendConversation(conv.id, true)
        refreshConversations()
        navigate(`/c/${conv.id}`, { replace: true })
      } catch (err) {
        log.error('failed to auto-create conversation:', err)
        return
      }
    }

    await audio.startRecording()
  }, [activeConversationId, trpc, audio, refreshConversations, navigate])

  const prevWakeDetectionRef = useRef(audio.wakeDetectionId)
  useEffect(() => {
    if (mode !== 'auto') {
      prevWakeDetectionRef.current = audio.wakeDetectionId
      return
    }

    if (audio.wakeDetectionId === prevWakeDetectionRef.current) {
      return
    }

    prevWakeDetectionRef.current = audio.wakeDetectionId
    void handleStartRecording()
  }, [mode, audio.wakeDetectionId, handleStartRecording])

  // When transcription arrives, start a new pending entry
  const prevTranscriptionRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      audio.transcription &&
      audio.transcription !== prevTranscriptionRef.current
    ) {
      prevTranscriptionRef.current = audio.transcription
      const entry: ConversationEntry = {
        id: nextIdRef.current++,
        userText: audio.transcription,
        userError: audio.transcriptionError,
      }
      setPendingEntry(entry)
    } else if (
      audio.transcription === null &&
      audio.transcriptionError &&
      audio.transcriptionError !== prevTranscriptionRef.current
    ) {
      prevTranscriptionRef.current = audio.transcriptionError
      const entry: ConversationEntry = {
        id: nextIdRef.current++,
        userText: '',
        userError: audio.transcriptionError,
      }
      setPendingEntry(entry)
    }
  }, [audio.transcription, audio.transcriptionError])

  // while TTS audio continues playing in the background.
  const prevAiResponseRef = useRef<string | null>(null)
  useEffect(() => {
    const hasNewResponse =
      audio.aiResponse !== null &&
      audio.aiResponse !== prevAiResponseRef.current

    const hasNewError =
      audio.aiError !== null && audio.aiError !== prevAiResponseRef.current

    if ((hasNewResponse || hasNewError) && pendingEntry) {
      prevAiResponseRef.current = audio.aiResponse ?? audio.aiError
      const finalized: ConversationEntry = {
        ...pendingEntry,
        assistantText: audio.aiResponse,
        assistantError: audio.aiError,
        toolCalls:
          audio.toolCalls.length > 0 ? [...audio.toolCalls] : undefined,
      }
      setConversation((prev) => [...prev, finalized])
      setPendingEntry(null)
      isFirstMessageRef.current = false
      refreshConversations()
    }
  }, [
    audio.aiResponse,
    audio.aiError,
    audio.toolCalls,
    pendingEntry,
    refreshConversations,
  ])

  // Keep phaseRef in sync (used by sound effects and other phase-dependent logic)
  useEffect(() => {
    phaseRef.current = audio.phase
  }, [audio.phase])

  // Auto-scroll to bottom when conversation changes (e.g. loading from menu)
  const conversationLength = conversation.length
  useEffect(() => {
    if (conversationLength > 0 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [conversationLength])

  // Play audio cues on phase transitions
  const prevPhaseForSoundRef = useRef(audio.phase)
  useEffect(() => {
    const prev = prevPhaseForSoundRef.current
    const curr = audio.phase
    prevPhaseForSoundRef.current = curr

    if (prev === curr) return

    if (curr === 'recording') {
      play('recordingStarted')
    }

    if (
      prev === 'recording' &&
      (curr === 'transcribing' || curr === 'thinking')
    ) {
      play('messageSent')
    }

    if (curr === 'done' && (audio.transcriptionError || audio.aiError)) {
      play('error')
    }
  }, [audio.phase, audio.transcriptionError, audio.aiError, play])

  // Audio heartbeat during long-running phases (thinking, synthesizing)
  useEffect(() => {
    const isProcessing =
      audio.phase === 'thinking' || audio.phase === 'synthesizing'
    if (!isProcessing) return

    // Play first pulse after 5 seconds, then every 5 seconds
    const timer = setInterval(() => {
      play('thinkingPulse')
    }, 5000)

    return () => clearInterval(timer)
  }, [audio.phase, play])

  // Push-to-talk with spacebar, Escape to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape cancels any in-progress processing or playback
      if (e.code === 'Escape' && audio.busy) {
        e.preventDefault()
        audio.cancelPlayback()
        return
      }

      if (
        e.code !== 'Space' ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }
      e.preventDefault()
      if (spaceDownRef.current) return
      spaceDownRef.current = true

      if (
        (audio.phase === 'idle' || audio.phase === 'done') &&
        audio.connected &&
        !audio.busy
      ) {
        handleStartRecording()
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      e.preventDefault()
      if (!spaceDownRef.current) return
      spaceDownRef.current = false

      if (audio.phase === 'recording') {
        audio.stopRecording()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [audio, handleStartRecording])

  const showStatus =
    audio.phase === 'passive-listening' ||
    audio.phase === 'recording' ||
    audio.phase === 'transcribing' ||
    audio.phase === 'thinking' ||
    audio.phase === 'synthesizing' ||
    audio.phase === 'speaking'

  const isEmpty = conversation.length === 0 && !pendingEntry && !showStatus

  return (
    <div className="flex flex-col h-dvh max-w-2xl mx-auto">
      {/* Conversation drawer */}
      <ConversationList
        open={drawerOpen}
        conversations={conversations}
        activeId={activeConversationId}
        onNew={createNewConversation}
        onDelete={deleteConversation}
        onClose={() => setDrawerOpen(false)}
      />

      {/* Voice command toast */}
      {audio.commandNotice && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 animate-fade-in-up">
          <div className="rounded-lg border border-border bg-card px-4 py-2 shadow-lg text-sm text-muted-foreground">
            {audio.commandNotice}
          </div>
        </div>
      )}

      {/* Header */}
      <ConnectionHeader
        apiConnected={health?.status === 'ok'}
        wsConnected={audio.connected}
        onMenuToggle={() => setDrawerOpen((o) => !o)}
      />

      {/* Scrollable chat area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-contain px-4 py-4"
      >
        <div className="flex flex-col gap-4">
          {isEmpty && (
            <div className="flex flex-col items-center justify-center h-full min-h-[50vh] text-center gap-3 animate-fade-in-up">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-primary/60"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <title>Microphone</title>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
                  />
                </svg>
              </div>
              <p className="text-sm text-muted-foreground">
                {mode === 'auto'
                  ? 'Say “Coda” or tap the mic to start hands-free'
                  : 'Tap the mic or hold space to start talking'}
              </p>
            </div>
          )}

          {conversation.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-3">
              {(entry.userText || entry.userError) && (
                <ChatMessage
                  sender="user"
                  content={entry.userText || 'No speech detected'}
                  error={entry.userError}
                />
              )}
              {(entry.assistantText || entry.assistantError) && (
                <ChatMessage
                  sender="assistant"
                  content={entry.assistantText ?? ''}
                  error={entry.assistantError}
                  toolCalls={entry.toolCalls}
                />
              )}
            </div>
          ))}

          {pendingEntry && (
            <div className="flex flex-col gap-3">
              <ChatMessage
                sender="user"
                content={pendingEntry.userText || 'No speech detected'}
                error={pendingEntry.userError}
              />
            </div>
          )}

          {showStatus && (
            <StatusIndicator
              phase={audio.phase}
              activeTools={audio.activeTools}
            />
          )}
        </div>
      </div>

      <MicButton
        phase={audio.phase}
        connected={audio.connected}
        busy={audio.busy}
        mode={mode}
        onStart={handleStartRecording}
        onStop={audio.stopRecording}
        onCancel={audio.cancelPlayback}
        onToggleMode={toggleMode}
      />
    </div>
  )
}
