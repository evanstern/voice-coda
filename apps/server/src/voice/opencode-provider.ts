import { logger } from '../logger.js'
import type { AIProvider, ChatParams, ChatResponse } from './ai-provider.js'

const log = logger.child({ module: 'opencode' })

const SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_EVICTION_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_OPENCODE_URL = 'http://127.0.0.1:4096'
const VOICE_MODE_PREFIX =
  '[VOICE MODE - respond in 2-3 spoken sentences max, no markdown, no code blocks, plain spoken language]\n\n'

interface OpenCodeSessionResponse {
  id: string
}

interface OpenCodeMessageResponse {
  info?: {
    modelID?: string
    providerID?: string
    cost?: number
    tokens?: {
      input?: number
      output?: number
      cache?: {
        write?: number
        read?: number
      }
    }
  }
  parts?: Array<Record<string, unknown>>
}

export class OpenCodeProvider implements AIProvider {
  readonly name = 'opencode'

  private readonly baseUrl = process.env.OPENCODE_URL ?? DEFAULT_OPENCODE_URL
  private sessionMap = new Map<string, string>()
  private sessionLastActive = new Map<string, number>()
  private pendingHistory = new Map<
    string,
    Array<{ role: 'user' | 'assistant'; content: string }>
  >()
  private pendingSessionCreation = new Map<string, Promise<string>>()
  private evictionTimer: ReturnType<typeof setInterval>

  constructor() {
    this.evictionTimer = setInterval(() => {
      const now = Date.now()
      for (const [sessionId, lastActive] of this.sessionLastActive) {
        if (now - lastActive > SESSION_TTL_MS) {
          log.debug(
            {
              session: sessionId.slice(0, 8),
              inactiveMin: Math.round((now - lastActive) / 1000 / 60),
            },
            'evicting stale session mapping',
          )
          this.sessionMap.delete(sessionId)
          this.sessionLastActive.delete(sessionId)
          this.pendingHistory.delete(sessionId)
          this.pendingSessionCreation.delete(sessionId)
        }
      }
    }, SESSION_EVICTION_INTERVAL_MS)
    this.evictionTimer.unref()
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const ocSessionId = await this.getOrCreateSessionId(
      params.sessionId,
      params.signal,
    )
    this.sessionLastActive.set(params.sessionId, Date.now())

    let promptText = params.userText

    const history = this.pendingHistory.get(params.sessionId)
    if (history && history.length > 0) {
      this.pendingHistory.delete(params.sessionId)
      const summary = history
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n')
      promptText = `[CONVERSATION HISTORY - the user is resuming a previous conversation]\n${summary}\n\n[CURRENT MESSAGE]\n${promptText}`
    }

    if (params.voiceContext) {
      promptText = `${VOICE_MODE_PREFIX}${promptText}`
    }

    const response = await this.request<OpenCodeMessageResponse>(
      `/session/${ocSessionId}/message`,
      {
        method: 'POST',
        body: JSON.stringify({
          parts: [{ type: 'text', text: promptText }],
        }),
      },
      params.signal,
    )

    const parts = Array.isArray(response.parts) ? response.parts : []
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => this.readString(part.text))
      .filter(Boolean)
      .join('\n')

    const toolCalls = this.extractToolCalls(parts)
    for (const toolCall of toolCalls) {
      params.onToolUse?.(toolCall.name, toolCall.input)
    }

    if (!response.info?.tokens) {
      log.warn('opencode response missing token usage data')
    }

    return {
      text,
      toolCalls,
      usage: {
        input_tokens: response.info?.tokens?.input ?? 0,
        output_tokens: response.info?.tokens?.output ?? 0,
        cache_creation_input_tokens: response.info?.tokens?.cache?.write ?? 0,
        cache_read_input_tokens: response.info?.tokens?.cache?.read ?? 0,
      },
      model: response.info?.modelID ?? 'opencode',
      providerID: response.info?.providerID,
      reportedCost: response.info?.cost,
    }
  }

  clearSession(sessionId: string): void {
    this.sessionMap.delete(sessionId)
    this.sessionLastActive.delete(sessionId)
    this.pendingHistory.delete(sessionId)
  }

  getExternalSessionId(sessionId: string): string | null {
    return this.sessionMap.get(sessionId) ?? null
  }

  setExternalSessionId(sessionId: string, externalSessionId: string): void {
    this.sessionMap.set(sessionId, externalSessionId)
    this.sessionLastActive.set(sessionId, Date.now())
    this.pendingHistory.delete(sessionId)
  }

  restoreSession(
    sessionId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): void {
    if (history.length > 0) {
      this.pendingHistory.set(sessionId, history)
      log.info(
        { session: sessionId.slice(0, 8), messageCount: history.length },
        'session history queued for restoration',
      )
    }
  }

  private async getOrCreateSessionId(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const existing = this.sessionMap.get(sessionId)
    if (existing) return existing

    const inflight = this.pendingSessionCreation.get(sessionId)
    if (inflight) return inflight

    const promise = this.createSession(sessionId, signal)
    this.pendingSessionCreation.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.pendingSessionCreation.delete(sessionId)
    }
  }

  private async createSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const created = await this.request<OpenCodeSessionResponse>(
      '/session',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
      signal,
    )

    this.sessionMap.set(sessionId, created.id)
    this.sessionLastActive.set(sessionId, Date.now())
    return created.id
  }

  private async request<T>(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)

    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason)
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    const url = new URL(pathname, this.baseUrl).toString()

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(
          `OpenCode request failed (${response.status} ${response.statusText}) at ${url}${body ? `: ${body}` : ''}`,
        )
      }

      return (await response.json()) as T
    } catch (error) {
      if (controller.signal.aborted) {
        throw error
      }

      // Rethrow application-level errors from the server as-is
      if (
        error instanceof Error &&
        error.message.startsWith('OpenCode request failed')
      ) {
        throw error
      }

      // Surface JSON parse failures clearly
      if (error instanceof SyntaxError) {
        throw new Error(
          `OpenCode server at ${this.baseUrl} returned invalid JSON for ${url}: ${error.message}`,
          { cause: error },
        )
      }

      // Network-level failures (ECONNREFUSED, DNS, timeout, etc.)
      const message =
        error instanceof Error ? error.message : 'Unknown network error'
      throw new Error(
        `Failed to reach OpenCode server at ${this.baseUrl}: ${message}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private extractToolCalls(
    parts: Array<Record<string, unknown>>,
  ): ChatResponse['toolCalls'] {
    return parts
      .filter((part) => {
        const type = this.readString(part.type)
        return Boolean(type?.includes('tool'))
      })
      .map((part) => {
        const name =
          this.readString(part.name) ||
          this.readString(
            (part.tool as Record<string, unknown> | undefined)?.name,
          ) ||
          'tool'

        const inputValue =
          part.input ??
          part.args ??
          part.parameters ??
          part.payload ??
          part.arguments ??
          null

        const resultValue =
          part.result ?? part.output ?? part.content ?? part.text ?? null

        return {
          name,
          input: this.serializeValue(inputValue),
          result: this.serializeValue(resultValue),
        }
      })
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  private serializeValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (value == null) return ''
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
}
