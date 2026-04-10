import { type ServerWsMessage, serverWsMessage } from '@voice-coda/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogger } from '~/lib/logger'

const log = createLogger('audio')

type ProcessingPhase =
  | 'idle'
  | 'passive-listening'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'done'

interface AudioSocketState {
  connected: boolean
  reconnecting: boolean
  reconnectCount: number
  phase: ProcessingPhase
  chunksReceived: number
  totalBytes: number
  transcription: string | null
  transcriptionError: string | null
  aiResponse: string | null
  aiError: string | null
  toolCalls: Array<{ name: string; input: string; result: string }>
  activeTools: string[]
  commandNotice: string | null
  wakeDetectionId: number
}

const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30000
const RECONNECT_MAX_ATTEMPTS = 10
const PASSIVE_LISTEN_WINDOW_MS = 2500

interface PlaybackHandle {
  promise: Promise<void>
  audio: HTMLAudioElement
}

function playAudio(data: ArrayBuffer, format = 'mp3'): PlaybackHandle {
  const mimeType =
    format === 'ogg_opus'
      ? 'audio/ogg'
      : format === 'wav'
        ? 'audio/wav'
        : 'audio/mpeg'
  const blob = new Blob([data], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)

  const promise = new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      URL.revokeObjectURL(url)
      resolve()
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Audio playback failed'))
    }
    audio.play().catch(reject)
  })

  return { promise, audio }
}

export function useAudioSocket(wsUrl: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const currentUrlRef = useRef<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordingModeRef = useRef<'active' | 'passive' | null>(null)
  const pendingRecorderActionRef = useRef<
    'none' | 'send-active' | 'detect-wake' | 'discard'
  >('none')
  const pendingActiveStartRef = useRef(false)
  const passiveListeningRef = useRef(false)
  const passiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPassiveWindowRef = useRef<(() => Promise<void>) | null>(null)
  const beginActiveRecordingRef = useRef<(() => Promise<void>) | null>(null)
  const expectingAudioRef = useRef(false)
  const audioFormatRef = useRef('mp3')
  const audioPlaybackRef = useRef<Promise<void> | null>(null)
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const lastConversationRef = useRef<{
    conversationId: string | null
    isFirstMessage: boolean
  } | null>(null)

  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  const [connectKey, setConnectKey] = useState(0)
  const [reconnectCount, setReconnectCount] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)

  const [state, setState] = useState<AudioSocketState>({
    connected: false,
    reconnecting: false,
    reconnectCount: 0,
    phase: 'idle',
    chunksReceived: 0,
    totalBytes: 0,
    transcription: null,
    transcriptionError: null,
    aiResponse: null,
    aiError: null,
    toolCalls: [],
    activeTools: [],
    commandNotice: null,
    wakeDetectionId: 0,
  })

  const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPassiveTimer = useCallback(() => {
    if (passiveTimerRef.current) {
      clearTimeout(passiveTimerRef.current)
      passiveTimerRef.current = null
    }
  }, [])

  const stopMicStream = useCallback(() => {
    const stream = streamRef.current
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }
    streamRef.current = null
  }, [])

  const ensureMicStream = useCallback(async () => {
    if (streamRef.current) {
      return streamRef.current
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      })
      setMicError(null)
      streamRef.current = stream
      return stream
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      log.error(`getUserMedia failed: ${err.message}`)

      if (err.name === 'NotAllowedError') {
        setMicError(
          'Microphone permission denied. Please allow microphone access and try again.',
        )
      } else if (err.name === 'NotFoundError') {
        setMicError(
          'No microphone found. Please connect a microphone and try again.',
        )
      } else {
        setMicError(err.message)
      }

      setState((s) => ({ ...s, phase: 'idle' }))
      return null
    }
  }, [])

  const handleRecorderStop = useCallback(() => {
    clearPassiveTimer()

    const action = pendingRecorderActionRef.current
    const mode = recordingModeRef.current
    const chunks = chunksRef.current

    mediaRecorderRef.current = null
    recordingModeRef.current = null
    pendingRecorderActionRef.current = 'none'
    chunksRef.current = []

    const ws = wsRef.current
    const canSend = ws && ws.readyState === WebSocket.OPEN

    if (action === 'detect-wake') {
      if (chunks.length > 0 && canSend) {
        const mimeType = chunks[0]?.type || 'audio/webm'
        const blob = new Blob(chunks, { type: mimeType })
        log.debug(
          `sending wake window: ${(blob.size / 1024).toFixed(1)} KB (${chunks.length} chunks)`,
        )
        ws.send(blob)
        ws.send(JSON.stringify({ type: 'detect_wake' }))
      } else if (passiveListeningRef.current) {
        void startPassiveWindowRef.current?.()
      }
    }

    if (action === 'send-active' && chunks.length > 0 && canSend) {
      const mimeType = chunks[0]?.type || 'audio/webm'
      const blob = new Blob(chunks, { type: mimeType })
      log.debug(
        `sending complete recording: ${(blob.size / 1024).toFixed(1)} KB (${chunks.length} chunks)`,
      )
      ws.send(blob)
      ws.send(JSON.stringify({ type: 'stop' }))
      log.info('recording stopped, requesting transcription')
    }

    const shouldKeepStream =
      mode === 'passive' &&
      (action === 'detect-wake' ||
        passiveListeningRef.current ||
        pendingActiveStartRef.current)

    if (!shouldKeepStream) {
      stopMicStream()
    }

    if (pendingActiveStartRef.current) {
      pendingActiveStartRef.current = false
      void beginActiveRecordingRef.current?.()
      return
    }

    if (
      mode === 'passive' &&
      action === 'discard' &&
      passiveListeningRef.current
    ) {
      void startPassiveWindowRef.current?.()
    }
  }, [clearPassiveTimer, stopMicStream])

  const createRecorder = useCallback(
    (stream: MediaStream, mode: 'active' | 'passive') => {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const mediaRecorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = mediaRecorder
      recordingModeRef.current = mode
      pendingRecorderActionRef.current = 'none'
      chunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
          log.debug(
            `buffered ${mode} chunk #${chunksRef.current.length} (${event.data.size} B)`,
          )
        }
      }

      mediaRecorder.onstop = () => {
        handleRecorderStop()
      }

      mediaRecorder.start(250)
      return mediaRecorder
    },
    [handleRecorderStop],
  )

  const startPassiveWindow = useCallback(async () => {
    if (mediaRecorderRef.current || !passiveListeningRef.current) {
      return
    }

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }

    const stream = await ensureMicStream()
    if (!stream || mediaRecorderRef.current || !passiveListeningRef.current) {
      return
    }

    const mediaRecorder = createRecorder(stream, 'passive')
    setState((s) => ({ ...s, phase: 'passive-listening' }))

    clearPassiveTimer()
    passiveTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current !== mediaRecorder) {
        return
      }

      pendingRecorderActionRef.current = 'detect-wake'
      mediaRecorder.requestData()
      mediaRecorder.stop()
    }, PASSIVE_LISTEN_WINDOW_MS)
  }, [clearPassiveTimer, createRecorder, ensureMicStream])

  startPassiveWindowRef.current = startPassiveWindow

  const beginActiveRecording = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || mediaRecorderRef.current) {
      return
    }

    const stream = await ensureMicStream()
    if (!stream || mediaRecorderRef.current) {
      return
    }

    createRecorder(stream, 'active')
    log.info('recording started')
    setState((s) => ({
      ...s,
      phase: 'recording',
      chunksReceived: 0,
      totalBytes: 0,
      transcription: null,
      transcriptionError: null,
      aiResponse: null,
      aiError: null,
      toolCalls: [],
      activeTools: [],
      commandNotice: null,
    }))
  }, [createRecorder, ensureMicStream])

  beginActiveRecordingRef.current = beginActiveRecording

  const startPassiveListening = useCallback(async () => {
    if (passiveListeningRef.current) {
      return
    }

    passiveListeningRef.current = true
    await startPassiveWindow()

    if (recordingModeRef.current !== 'passive') {
      passiveListeningRef.current = false
    }
  }, [startPassiveWindow])

  const stopPassiveListening = useCallback(() => {
    passiveListeningRef.current = false
    pendingActiveStartRef.current = false
    clearPassiveTimer()

    const mediaRecorder = mediaRecorderRef.current
    if (mediaRecorder && recordingModeRef.current === 'passive') {
      pendingRecorderActionRef.current = 'discard'
      mediaRecorder.requestData()
      mediaRecorder.stop()
    } else {
      stopMicStream()
    }

    setState((s) => ({ ...s, phase: 'idle' }))
  }, [clearPassiveTimer, stopMicStream])

  // biome-ignore lint/correctness/useExhaustiveDependencies: connectKey intentionally triggers reconnection
  useEffect(() => {
    if (!wsUrl) return

    // If we already have a connection to this URL, don't recreate it
    if (
      wsRef.current &&
      currentUrlRef.current === wsUrl &&
      wsRef.current.readyState !== WebSocket.CLOSED
    ) {
      log.debug('reusing existing WebSocket connection')
      return
    }

    // Close old connection only if URL changed
    if (wsRef.current && currentUrlRef.current !== wsUrl) {
      log.debug('URL changed, closing old connection')
      intentionalCloseRef.current = true
      wsRef.current.close()
    }

    intentionalCloseRef.current = false
    currentUrlRef.current = wsUrl
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      log.info('connected to', wsUrl)
      const wasReconnect = reconnectAttemptRef.current > 0
      const lastConversation = lastConversationRef.current
      reconnectAttemptRef.current = 0
      setState((s) => ({
        ...s,
        connected: true,
        reconnecting: false,
        reconnectCount: wasReconnect ? s.reconnectCount + 1 : s.reconnectCount,
      }))

      if (wasReconnect && lastConversation?.conversationId) {
        ws.send(
          JSON.stringify({
            type: 'set_conversation',
            conversationId: lastConversation.conversationId,
            isFirstMessage: lastConversation.isFirstMessage,
          }),
        )
      }
    }

    ws.onmessage = (event) => {
      // Binary message = TTS audio
      if (event.data instanceof ArrayBuffer) {
        if (!expectingAudioRef.current) {
          log.warn('unexpected binary message, ignoring')
          return
        }
        expectingAudioRef.current = false
        const bytes = event.data.byteLength
        log.debug(`received TTS audio: ${(bytes / 1024).toFixed(1)} KB`)

        setState((s) => ({ ...s, phase: 'speaking' }))
        const handle = playAudio(event.data, audioFormatRef.current)
        audioElementRef.current = handle.audio
        const playbackPromise = handle.promise
          .then(() => {
            log.debug('playback complete')
            audioElementRef.current = null
            setState((s) => ({ ...s, phase: 'done' }))
          })
          .catch((err) => {
            log.error('playback error:', err)
            audioElementRef.current = null
            setState((s) => ({ ...s, phase: 'done' }))
          })

        // Store playback promise so it can complete even after hot reload
        audioPlaybackRef.current = playbackPromise
        return
      }

      // Text message = JSON control
      let raw: unknown
      try {
        raw = JSON.parse(event.data)
      } catch {
        // Ignore non-JSON text messages
        return
      }

      const result = serverWsMessage.safeParse(raw)
      if (!result.success) {
        log.warn('ignoring unrecognized server message', raw)
        return
      }

      const msg: ServerWsMessage = result.data

      switch (msg.type) {
        case 'audio_ack':
          log.debug(
            `ack chunk #${msg.chunk} (${msg.bytes} B, total: ${msg.totalBytes} B)`,
          )
          setState((s) => ({
            ...s,
            chunksReceived: msg.chunk,
            totalBytes: msg.totalBytes,
          }))
          break

        case 'transcribing':
          log.debug(`transcribing ${msg.bytes} B...`)
          setState((s) => ({ ...s, phase: 'transcribing' }))
          break

        case 'transcription':
          if (msg.error) {
            log.error(`transcription error: ${msg.error}`)
          } else {
            log.info(`transcription: "${msg.text}"`)
          }
          setState((s) => ({
            ...s,
            transcription: msg.text ?? null,
            transcriptionError: msg.error ?? null,
            phase: msg.text ? s.phase : 'done',
          }))
          break

        case 'thinking':
          log.debug('ai is thinking')
          setState((s) => ({ ...s, phase: 'thinking' }))
          break

        case 'tool_use':
          log.debug(`ai using tool: ${msg.name}`)
          setState((s) => ({
            ...s,
            activeTools: [...s.activeTools, msg.name],
          }))
          break

        case 'ai_response':
          if (msg.error) {
            log.error(`ai error: ${msg.error}`)
            setState((s) => ({
              ...s,
              phase: 'done',
              aiResponse: null,
              aiError: msg.error ?? null,
              toolCalls: msg.toolCalls ?? [],
              activeTools: [],
            }))
          } else {
            log.info(`ai: "${(msg.text ?? '').slice(0, 100)}..."`)
            // Don't set phase to 'done' yet — TTS may follow
            setState((s) => ({
              ...s,
              aiResponse: msg.text ?? null,
              aiError: null,
              toolCalls: msg.toolCalls ?? [],
              activeTools: [],
            }))
          }
          break

        case 'synthesizing':
          log.info('synthesizing TTS...')
          setState((s) => ({ ...s, phase: 'synthesizing' }))
          break

        case 'tts_audio':
          log.debug(`TTS audio header: ${msg.format}, ${msg.bytes} B`)
          expectingAudioRef.current = true
          audioFormatRef.current = msg.format
          break

        case 'tts_error':
          log.error(`TTS error: ${msg.error}`)
          setState((s) => ({ ...s, phase: 'done' }))
          break

        case 'conversation_updated':
          log.info('conversation updated after reconnect, refreshing')
          setReconnectCount((c) => c + 1)
          break

        case 'processing_pending':
          log.info('previous processing still in progress')
          setState((s) => ({ ...s, phase: 'thinking' }))
          break

        case 'command': {
          const label =
            msg.command === 'disregard'
              ? 'Message discarded'
              : msg.command === 'clear'
                ? 'Conversation cleared'
                : `Command: ${msg.command}`
          log.info(`voice command: ${msg.command}`)
          setState((s) => ({
            ...s,
            phase: 'done',
            commandNotice: label,
            // Clear conversation state on reset
            ...(msg.command === 'clear'
              ? {
                  transcription: null,
                  aiResponse: null,
                  aiError: null,
                  toolCalls: [],
                }
              : {}),
          }))
          // Auto-dismiss the notice after 3 seconds
          if (commandTimerRef.current) {
            clearTimeout(commandTimerRef.current)
          }
          commandTimerRef.current = setTimeout(() => {
            setState((s) => ({ ...s, commandNotice: null }))
            commandTimerRef.current = null
          }, 3000)
          break
        }

        case 'error':
          log.error(msg.error)
          setState((s) => ({
            ...s,
            phase: 'done',
            transcriptionError: msg.error,
          }))
          break

        case 'wake_detection':
          log.debug(
            `wake detection: ${msg.detected ? 'matched' : 'no match'}${msg.text ? ` (\"${msg.text}\")` : ''}`,
          )

          if (msg.detected) {
            passiveListeningRef.current = false
            clearPassiveTimer()
            setState((s) => ({
              ...s,
              wakeDetectionId: s.wakeDetectionId + 1,
            }))
          } else if (passiveListeningRef.current) {
            void startPassiveWindowRef.current?.()
          }
          break
      }
    }

    ws.onclose = (event) => {
      log.info(`ws closed (code=${event.code})`)
      passiveListeningRef.current = false
      pendingActiveStartRef.current = false
      clearPassiveTimer()
      stopMicStream()
      setState((s) => ({ ...s, connected: false, phase: 'idle' }))

      if (
        !intentionalCloseRef.current &&
        reconnectAttemptRef.current < RECONNECT_MAX_ATTEMPTS
      ) {
        const attempt = reconnectAttemptRef.current + 1
        const delay = Math.min(
          RECONNECT_BASE_DELAY * 2 ** (attempt - 1),
          RECONNECT_MAX_DELAY,
        )
        log.info(`reconnecting (attempt ${attempt}) in ${delay}ms...`)
        setState((s) => ({ ...s, reconnecting: true }))
        reconnectAttemptRef.current = attempt
        reconnectTimerRef.current = setTimeout(() => {
          currentUrlRef.current = null
          wsRef.current = null
          setConnectKey((k) => k + 1)
        }, delay)
      } else if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        log.warn('max reconnection attempts reached, giving up')
        setState((s) => ({ ...s, reconnecting: false }))
      }
    }

    ws.onerror = () => {
      log.error('ws error')
      setState((s) => ({ ...s, connected: false }))
    }

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [wsUrl, connectKey, clearPassiveTimer, stopMicStream])

  // Separate effect to handle true unmount
  useEffect(() => {
    return () => {
      // This only runs on true unmount
      if (wsRef.current) {
        log.debug('component unmounting, closing WebSocket')
        intentionalCloseRef.current = true
        wsRef.current.close()
        wsRef.current = null
        currentUrlRef.current = null
      }
      passiveListeningRef.current = false
      pendingActiveStartRef.current = false
      clearPassiveTimer()
      stopMicStream()
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [clearPassiveTimer, stopMicStream])

  const startRecording = useCallback(async () => {
    passiveListeningRef.current = false
    clearPassiveTimer()

    const mediaRecorder = mediaRecorderRef.current
    if (mediaRecorder && recordingModeRef.current === 'passive') {
      pendingActiveStartRef.current = true
      pendingRecorderActionRef.current = 'discard'
      mediaRecorder.requestData()
      mediaRecorder.stop()
      return
    }

    await beginActiveRecording()
  }, [beginActiveRecording, clearPassiveTimer])

  const stopRecording = useCallback(() => {
    const mediaRecorder = mediaRecorderRef.current
    if (
      mediaRecorder &&
      mediaRecorder.state !== 'inactive' &&
      recordingModeRef.current === 'active'
    ) {
      pendingRecorderActionRef.current = 'send-active'
      mediaRecorder.requestData()
      mediaRecorder.stop()
    }
  }, [])

  const cancelRecording = useCallback(() => {
    passiveListeningRef.current = false
    pendingActiveStartRef.current = false
    clearPassiveTimer()

    const mediaRecorder = mediaRecorderRef.current
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      pendingRecorderActionRef.current = 'discard'
      mediaRecorder.requestData()
      mediaRecorder.stop()
    }
    chunksRef.current = []
    stopMicStream()

    setState((s) => ({
      ...s,
      phase: 'idle',
    }))

    log.info('recording cancelled, no audio sent')
  }, [clearPassiveTimer, stopMicStream])

  const cancelPlayback = useCallback(() => {
    // Stop any in-progress audio playback
    const audioEl = audioElementRef.current
    if (audioEl) {
      audioEl.pause()
      audioEl.currentTime = 0
      audioElementRef.current = null
      log.info('playback cancelled by user')
    }

    // Clear pending audio expectations
    expectingAudioRef.current = false

    // Tell the server to cancel any in-progress processing
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel' }))
    }

    setState((s) => ({ ...s, phase: 'done', activeTools: [] }))
  }, [])

  const sendConversation = useCallback(
    (conversationId: string | null, isFirstMessage: boolean) => {
      lastConversationRef.current = { conversationId, isFirstMessage }
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'set_conversation',
            conversationId,
            isFirstMessage,
          }),
        )
      }
    },
    [],
  )

  const setPhase = useCallback((phase: ProcessingPhase) => {
    setState((s) => ({ ...s, phase }))
  }, [])

  const busy =
    state.phase !== 'idle' &&
    state.phase !== 'done' &&
    state.phase !== 'passive-listening' &&
    state.phase !== 'recording'

  // Expose the mic stream so VAD can attach to it
  const micStream = streamRef.current

  return {
    ...state,
    reconnectCount,
    busy,
    micError,
    startRecording,
    startPassiveListening,
    stopPassiveListening,
    stopRecording,
    cancelRecording,
    cancelPlayback,
    micStream,
    sendConversation,
    setPhase,
  }
}
