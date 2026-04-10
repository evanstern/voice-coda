import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import {
  type ClientWsMessage,
  type ControlMessage,
  clientWsMessage,
} from '@voice-coda/contracts'
import { type WebSocket, WebSocketServer } from 'ws'
import { logger } from '../logger.js'
import {
  appendMessage,
  autoTitle,
  getAISessionId,
  getConversation,
  updateAISessionId,
} from '../storage/conversations.js'
import { getAIProvider } from '../voice/ai-provider.js'
import {
  chat,
  clearSession,
  getExternalSessionId,
  restoreSession,
  setExternalSessionId,
} from '../voice/claude.js'
import {
  cleanupSession,
  finalizeInteraction,
  recordLLM,
  recordSTT,
  recordTTS,
} from '../voice/cost-tracker.js'
import { getSTTProvider, transcribe } from '../voice/stt.js'
import { filterForTTS } from '../voice/text-filter.js'
import { getTTSProvider } from '../voice/tts.js'
import { processVoiceInput } from '../voice/voice-middleware.js'
import { detectWakePhrase } from '../voice/wake-phrase.js'

const log = logger.child({ module: 'ws' })

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function elapsed(startMs: number): string {
  const sec = (Date.now() - startMs) / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  return `${Math.floor(sec / 60)}m ${(sec % 60).toFixed(0)}s`
}

const MAX_AUDIO_BUFFER_BYTES = 10 * 1024 * 1024 // 10 MB

const inflightByConversation = new Map<
  string,
  { promise: Promise<void>; resolve: () => void; sessionId: string }
>()

const conversationWatchers = new Map<string, Set<WebSocket>>()

function registerWatcher(conversationId: string, ws: WebSocket) {
  const watchers =
    conversationWatchers.get(conversationId) ?? new Set<WebSocket>()
  watchers.add(ws)
  conversationWatchers.set(conversationId, watchers)
}

function unregisterWatcher(conversationId: string | null, ws: WebSocket) {
  if (!conversationId) {
    return
  }

  const watchers = conversationWatchers.get(conversationId)
  if (!watchers) {
    return
  }

  watchers.delete(ws)
  if (watchers.size === 0) {
    conversationWatchers.delete(conversationId)
  }
}

function notifyConversationUpdated(conversationId: string) {
  const watchers = conversationWatchers.get(conversationId)
  if (!watchers) {
    return
  }

  for (const watcher of watchers) {
    send(watcher, { type: 'conversation_updated', conversationId })
  }
}

function send(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function verifyAuth(req: IncomingMessage): boolean {
  const authSecret = process.env.AUTH_SECRET
  if (!authSecret) return true

  const authHeader = req.headers.authorization
  if (authHeader === `Bearer ${authSecret}`) return true

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  )
  const token = url.searchParams.get('token')
  if (token === authSecret) return true

  return false
}

export function attachWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/audio' })

  wss.on('connection', (ws, req: IncomingMessage) => {
    if (!verifyAuth(req)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const client = req.socket.remoteAddress ?? 'unknown'
    const sessionId = randomUUID()
    const connectedAt = Date.now()
    let chunkCount = 0
    let totalBytes = 0
    let streamStartedAt: number | null = null
    let audioChunks: Buffer[] = []
    let conversationId: string | null = null
    let isFirstMessage = true
    let processingAbort: AbortController | null = null

    log.info({ client, session: sessionId.slice(0, 8) }, 'connected')

    const resetBufferedAudio = () => {
      audioChunks = []
      chunkCount = 0
      totalBytes = 0
      streamStartedAt = null
    }

    ws.on('message', async (data, isBinary) => {
      if (!isBinary) {
        let raw: unknown
        try {
          raw = JSON.parse(data.toString())
        } catch {
          log.warn('ignoring malformed JSON')
          return
        }

        const result = clientWsMessage.safeParse(raw)
        if (!result.success) {
          log.warn({ raw }, 'ignoring unrecognized message')
          return
        }

        const msg: ClientWsMessage = result.data

        // Handle conversation assignment
        if (msg.type === 'set_conversation') {
          unregisterWatcher(conversationId, ws)
          conversationId = msg.conversationId
          isFirstMessage = msg.isFirstMessage ?? true
          log.info(
            { conversationId: conversationId?.slice(0, 8) ?? 'none' },
            'conversation set',
          )

          clearSession(sessionId)
          if (conversationId) {
            const conv = await getConversation(conversationId)
            if (conv && conv.messages.length > 0) {
              restoreSession(
                sessionId,
                conv.messages.map((m) => ({
                  role: m.role,
                  content: m.content,
                })),
              )
            }

            const storedAISessionId = await getAISessionId(conversationId)
            if (storedAISessionId) {
              setExternalSessionId(sessionId, storedAISessionId)
            }

            const inflight = inflightByConversation.get(conversationId)
            if (inflight) {
              log.info('waiting for in-flight processing to complete')
              send(ws, { type: 'processing_pending', conversationId })
              await inflight.promise
            }

            registerWatcher(conversationId, ws)
          }

          send(ws, { type: 'conversation_set', conversationId })
          return
        }

        // Handle cancel inline — abort any in-progress processing
        if (msg.type === 'cancel') {
          if (processingAbort) {
            log.debug('cancel: aborting in-progress processing')
            processingAbort.abort()
            processingAbort = null
          }
          send(ws, { type: 'cancelled' })
          return
        }

        handleControl(ws, sessionId, msg, () => ({
          audioChunks,
          resetAudio: resetBufferedAudio,
          conversationId,
          isFirstMessage,
          setFirstMessage: (val: boolean) => {
            isFirstMessage = val
          },
          getAbortSignal: () => {
            processingAbort = new AbortController()
            return processingAbort.signal
          },
          clearAbort: () => {
            processingAbort = null
          },
        }))
        return
      }

      if (chunkCount === 0) {
        streamStartedAt = Date.now()
        log.debug('audio stream started')
      }

      chunkCount++
      const chunk = data as Buffer
      const bytes = chunk.byteLength
      totalBytes += bytes
      audioChunks.push(chunk)

      // Enforce max buffer size to prevent memory exhaustion
      if (totalBytes > MAX_AUDIO_BUFFER_BYTES) {
        log.warn(
          { maxBytes: MAX_AUDIO_BUFFER_BYTES },
          'audio buffer exceeded limit, clearing',
        )
        resetBufferedAudio()
        send(ws, {
          type: 'error',
          error: 'Audio buffer exceeded 10 MB limit. Recording cleared.',
        })
        return
      }

      log.debug(
        { chunk: chunkCount, size: bytes, total: totalBytes },
        'audio chunk received',
      )

      send(ws, {
        type: 'audio_ack',
        chunk: chunkCount,
        bytes,
        totalBytes,
      })
    })

    ws.on('close', (code) => {
      const duration = elapsed(connectedAt)
      const streamDuration = streamStartedAt ? elapsed(streamStartedAt) : 'n/a'
      const avgChunkSize =
        chunkCount > 0
          ? formatBytes(Math.round(totalBytes / chunkCount))
          : 'n/a'

      log.info(
        {
          code,
          duration,
          streamDuration,
          chunks: chunkCount,
          totalBytes,
          avgChunkSize,
        },
        'connection closed',
      )

      unregisterWatcher(conversationId, ws)

      // Clean up server-side state for this session
      audioChunks = []
      chunkCount = 0
      totalBytes = 0
      streamStartedAt = null
      clearSession(sessionId)

      const inflight = conversationId
        ? inflightByConversation.get(conversationId)
        : undefined
      if (inflight?.sessionId === sessionId) {
        void inflight.promise.then(() => {
          cleanupSession(sessionId)
        })
      } else {
        cleanupSession(sessionId)
      }
    })

    ws.on('error', (err) => {
      log.error({ err: err.message }, 'WebSocket error')
    })

    send(ws, {
      type: 'connected',
      sessionId,
      message: 'WebSocket audio channel open',
      timestamp: Date.now(),
    })
  })

  return wss
}

async function handleControl(
  ws: WebSocket,
  sessionId: string,
  msg: ControlMessage,
  getAudioState: () => {
    audioChunks: Buffer[]
    resetAudio: () => void
    conversationId: string | null
    isFirstMessage: boolean
    setFirstMessage: (val: boolean) => void
    getAbortSignal: () => AbortSignal
    clearAbort: () => void
  },
) {
  log.debug({ type: msg.type }, 'control message')

  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong', timestamp: Date.now() })
      break

    case 'stop': {
      const {
        audioChunks,
        resetAudio,
        conversationId,
        isFirstMessage,
        setFirstMessage,
        getAbortSignal,
        clearAbort,
      } = getAudioState()

      const signal = getAbortSignal()
      const existingInflight = conversationId
        ? inflightByConversation.get(conversationId)
        : undefined

      if (existingInflight) {
        log.info(
          { conversationId: conversationId?.slice(0, 8) ?? 'none' },
          'processing already in flight for conversation',
        )
        send(ws, { type: 'processing_pending', conversationId })
        clearAbort()
        break
      }

      let inflightEntry: {
        promise: Promise<void>
        resolve: () => void
        sessionId: string
      } | null = null
      let inflightConversationId: string | null = null
      let inflightRegistered = false

      if (conversationId) {
        inflightConversationId = conversationId
        let resolveInflight = () => {}
        const promise = new Promise<void>((resolve) => {
          resolveInflight = resolve
        })
        inflightEntry = {
          promise,
          resolve: resolveInflight,
          sessionId,
        }
        inflightByConversation.set(conversationId, inflightEntry)
        inflightRegistered = true
      }

      try {
        if (audioChunks.length === 0) {
          send(ws, {
            type: 'transcription',
            text: '',
            error: 'No audio received',
          })
          clearAbort()
          break
        }

        let combined: Buffer
        try {
          combined = Buffer.concat(audioChunks)
        } finally {
          resetAudio()
        }

        // Phase 1: Transcribe
        send(ws, { type: 'transcribing', bytes: combined.byteLength })

        let userText: string
        try {
          const result = await transcribe(combined)
          userText = result.text
          const sttProvider = getSTTProvider()
          recordSTT(
            sessionId,
            result.durationSec,
            sttProvider.name,
            'whisper-1',
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          log.error({ err: message }, 'STT error')
          send(ws, { type: 'transcription', text: '', error: message })
          clearAbort()
          break
        }

        if (signal.aborted) {
          log.debug('cancelled after transcription')
          clearAbort()
          break
        }

        // Process voice input through middleware
        const providerName = getAIProvider().name
        const voiceInput = await processVoiceInput({
          rawText: userText,
          sessionId,
          provider: providerName,
        })

        if (voiceInput.command === 'disregard') {
          log.info('voice command: disregard, dropping message')
          send(ws, { type: 'transcription', text: userText })
          send(ws, { type: 'command', command: 'disregard' })
          clearAbort()
          break
        }

        if (voiceInput.command === 'clear') {
          log.info(
            { session: sessionId.slice(0, 8) },
            'voice command: clear, resetting session',
          )
          clearSession(sessionId)
          send(ws, { type: 'transcription', text: userText })
          send(ws, { type: 'command', command: 'clear' })
          clearAbort()
          break
        }

        send(ws, { type: 'transcription', text: voiceInput.displayText })

        if (!voiceInput.displayText) {
          clearAbort()
          break
        }

        // Persist user message (clean text without system decorations)
        if (conversationId) {
          await appendMessage(conversationId, {
            role: 'user',
            content: voiceInput.displayText,
          })
          if (isFirstMessage) {
            await autoTitle(conversationId, voiceInput.displayText)
            setFirstMessage(false)
          }
        }

        send(ws, { type: 'thinking' })

        if (voiceInput.operationalIntents.length > 0) {
          log.debug(
            { intents: voiceInput.operationalIntents },
            'detected operational intents',
          )
        }

        try {
          const response = await chat(
            sessionId,
            voiceInput.chatText,
            (toolName, toolInput) => {
              send(ws, { type: 'tool_use', name: toolName, input: toolInput })
            },
            signal,
            voiceInput.voiceContext,
            voiceInput.routingHint,
          )

          recordLLM(
            sessionId,
            response.usage,
            response.model,
            response.providerID ?? providerName,
            response.reportedCost,
          )

          // Persist assistant message
          if (conversationId) {
            await appendMessage(conversationId, {
              role: 'assistant',
              content: response.text ?? '',
              toolCalls: response.toolCalls,
            })

            const externalId = getExternalSessionId(sessionId)
            if (externalId) {
              await updateAISessionId(conversationId, externalId)
            }
          }

          if (signal.aborted) {
            log.debug('cancelled after ai response')
            // Still send the response text so it appears in chat, just skip TTS
            send(ws, {
              type: 'ai_response',
              text: response.text,
              toolCalls: response.toolCalls,
            })
            finalizeInteraction(sessionId)
            clearAbort()
            break
          }

          send(ws, {
            type: 'ai_response',
            text: response.text,
            toolCalls: response.toolCalls,
          })

          //   Filter out code blocks, inline code, and raw paths first so
          //   we only pay for (and hear) the conversational content.
          const spokenText = response.text ? filterForTTS(response.text) : ''
          if (spokenText && !signal.aborted) {
            send(ws, { type: 'synthesizing' })

            try {
              const ttsProvider = await getTTSProvider()
              recordTTS(sessionId, spokenText.length, ttsProvider.name, 'tts-1')
              const audioBuffer = await ttsProvider.synthesize(spokenText)

              if (signal.aborted) {
                log.debug('cancelled after TTS synthesis')
                finalizeInteraction(sessionId)
                clearAbort()
                break
              }

              send(ws, {
                type: 'tts_audio',
                format: ttsProvider.defaultFormat,
                bytes: audioBuffer.byteLength,
              })
              // Send the raw audio as binary
              if (ws.readyState === ws.OPEN) {
                ws.send(audioBuffer)
              }
            } catch (ttsErr) {
              const ttsMsg =
                ttsErr instanceof Error ? ttsErr.message : 'Unknown error'
              log.error({ err: ttsMsg }, 'TTS error')
              send(ws, { type: 'tts_error', error: ttsMsg })
            }
          }

          finalizeInteraction(sessionId)
        } catch (err) {
          if (signal.aborted) {
            log.debug('cancelled during ai call')
            finalizeInteraction(sessionId)
            clearAbort()
            break
          }
          const message = err instanceof Error ? err.message : 'Unknown error'
          log.error({ err: message }, 'AI error')
          send(ws, { type: 'ai_response', text: '', error: message })
          finalizeInteraction(sessionId)
        }
        clearAbort()
      } finally {
        if (inflightRegistered && inflightConversationId) {
          inflightByConversation.delete(inflightConversationId)
          inflightEntry?.resolve()

          if (ws.readyState !== ws.OPEN) {
            notifyConversationUpdated(inflightConversationId)
          }
        }
      }
      break
    }

    case 'detect_wake': {
      const { audioChunks, resetAudio } = getAudioState()

      if (audioChunks.length === 0) {
        send(ws, { type: 'wake_detection', detected: false, text: '' })
        break
      }

      let combined: Buffer
      try {
        combined = Buffer.concat(audioChunks)
      } finally {
        resetAudio()
      }

      let transcript = ''
      try {
        const result = await transcribe(combined)
        transcript = result.text
        const sttProvider = getSTTProvider()
        recordSTT(sessionId, result.durationSec, sttProvider.name, 'whisper-1')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        log.error({ err: message }, 'wake detection STT error')
        send(ws, { type: 'wake_detection', detected: false, text: '' })
        break
      }

      const wake = detectWakePhrase(transcript)

      log.debug(
        { detected: wake.detected, transcript: wake.transcript },
        'wake phrase check complete',
      )

      send(ws, {
        type: 'wake_detection',
        detected: wake.detected,
        text: wake.transcript,
      })
      break
    }
  }
}
