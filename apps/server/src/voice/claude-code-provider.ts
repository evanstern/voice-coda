import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import type { AIProvider, ChatParams, ChatResponse } from './ai-provider.js'

const log = logger.child({ module: 'claude-code' })

const WORK_DIR = process.env.WORK_DIR ?? process.cwd()

// Default timeout for a single claude invocation (2 minutes)
const PROCESS_TIMEOUT_MS = 120_000

export class ClaudeCodeProvider implements AIProvider {
  readonly name = 'claude-code'

  // Map our sessionId -> Claude Code session UUID.
  // Claude Code manages its own conversation history per session,
  // so we just need to keep the mapping stable.
  private sessionMap = new Map<string, string>()

  // Track whether we've made at least one call for a session.
  // First call uses --session-id, subsequent calls use --resume.
  private hasCalledSession = new Set<string>()

  async chat(params: ChatParams): Promise<ChatResponse> {
    const ccSessionId = this.getOrCreateSessionId(params.sessionId)
    const isFirstCall = !this.hasCalledSession.has(ccSessionId)

    const systemPrompt = params.voiceContext?.systemPrompt ?? ''

    const args = [
      '-p',
      params.userText,
      '--output-format',
      'stream-json',
      '--verbose',
      ...(isFirstCall
        ? ['--session-id', ccSessionId]
        : ['--resume', ccSessionId]),
      '--permission-mode',
      process.env.CLAUDE_CODE_PERMISSION_MODE ?? 'bypassPermissions',
      ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    ]

    // Optionally restrict which tools Claude Code can use
    if (process.env.CLAUDE_CODE_TOOLS) {
      args.push('--tools', process.env.CLAUDE_CODE_TOOLS)
    }

    // Optionally set model
    if (process.env.CLAUDE_CODE_MODEL) {
      args.push('--model', process.env.CLAUDE_CODE_MODEL)
    }

    return new Promise<ChatResponse>((resolve, reject) => {
      let proc: ChildProcess

      try {
        proc = spawn('claude', args, {
          cwd: WORK_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ANTHROPIC_API_KEY: undefined },
        })
      } catch (err) {
        reject(
          new Error(
            'Failed to spawn Claude Code CLI. Is it installed? npm install -g @anthropic-ai/claude-code',
          ),
        )
        return
      }

      this.hasCalledSession.add(ccSessionId)

      let resultText = ''
      const toolCalls: ChatResponse['toolCalls'] = []
      let model = ''
      let usage: ChatResponse['usage'] = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }
      let buffer = ''
      let aborted = false

      // Track tool_use IDs so we can match results back
      const pendingToolUseIds = new Map<
        string,
        { name: string; input: string }
      >()

      // Kill the child process and rotate session ID when abort fires
      if (params.signal) {
        const onAbort = () => {
          aborted = true
          log.info('abort signal received, killing process')
          proc.kill('SIGTERM')
          // Rotate the session ID so the next request doesn't collide
          this.sessionMap.delete(params.sessionId)
        }
        if (params.signal.aborted) {
          onAbort()
        } else {
          params.signal.addEventListener('abort', onAbort, { once: true })
        }
      }

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error('Claude Code CLI timed out'))
      }, PROCESS_TIMEOUT_MS)

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            processEvent(
              event,
              params,
              toolCalls,
              pendingToolUseIds,
              (t, u, m) => {
                resultText = t
                usage = u
                model = m
              },
            )
          } catch {
            // skip malformed JSON lines
          }
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          log.error({ stderr: text }, 'process stderr')
        }
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)

        // If aborted, resolve with whatever we have so far
        if (aborted) {
          resolve({
            text: resultText || '',
            toolCalls,
            usage,
            model: model || 'claude-code',
          })
          return
        }

        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer)
            processEvent(
              event,
              params,
              toolCalls,
              pendingToolUseIds,
              (t, u, m) => {
                resultText = t
                usage = u
                model = m
              },
            )
          } catch {
            // ignore
          }
        }

        if (code !== 0 && !resultText) {
          reject(new Error(`Claude Code CLI exited with code ${code}`))
        } else {
          resolve({ text: resultText, toolCalls, usage, model })
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
            ),
          )
        } else {
          reject(err)
        }
      })
    })
  }

  clearSession(sessionId: string): void {
    // Discard the mapping so the next chat() call starts a fresh Claude Code session
    const ccSessionId = this.sessionMap.get(sessionId)
    if (ccSessionId) {
      this.hasCalledSession.delete(ccSessionId)
    }
    this.sessionMap.delete(sessionId)
  }

  getExternalSessionId(sessionId: string): string | null {
    return this.sessionMap.get(sessionId) ?? null
  }

  setExternalSessionId(sessionId: string, externalSessionId: string): void {
    this.sessionMap.set(sessionId, externalSessionId)
    this.hasCalledSession.add(externalSessionId)
  }

  restoreSession(
    _sessionId: string,
    _history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): void {
    // No-op: Claude Code manages its own session history via --session-id.
    // When we reuse the same session-id, it picks up prior context automatically.
  }

  private getOrCreateSessionId(sessionId: string): string {
    const existing = this.sessionMap.get(sessionId)
    if (existing) return existing

    const newId = randomUUID()
    this.sessionMap.set(sessionId, newId)
    return newId
  }
}

// --- Stream event processing ---

interface StreamAssistantEvent {
  type: 'assistant'
  message?: {
    model?: string
    content?: Array<{
      type: string
      id?: string
      name?: string
      text?: string
      input?: Record<string, unknown>
    }>
  }
}

interface StreamUserEvent {
  type: 'user'
  message?: {
    content?: Array<{
      type: string
      tool_use_id?: string
      content?: string
      is_error?: boolean
    }>
  }
  tool_use_result?: {
    stdout?: string
    stderr?: string
  }
}

interface StreamResultEvent {
  type: 'result'
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  modelUsage?: Record<string, unknown>
}

type StreamEvent =
  | StreamAssistantEvent
  | StreamUserEvent
  | StreamResultEvent
  | { type: string }

function processEvent(
  event: StreamEvent,
  params: ChatParams,
  toolCalls: ChatResponse['toolCalls'],
  pendingToolUseIds: Map<string, { name: string; input: string }>,
  setResult: (
    text: string,
    usage: ChatResponse['usage'],
    model: string,
  ) => void,
): void {
  switch (event.type) {
    case 'assistant': {
      const msg = (event as StreamAssistantEvent).message
      if (!msg?.content) break

      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name && block.id) {
          const inputStr = JSON.stringify(block.input ?? {})
          params.onToolUse?.(block.name, inputStr)
          pendingToolUseIds.set(block.id, {
            name: block.name,
            input: inputStr,
          })
          // Push a placeholder into toolCalls; result filled in on user event
          toolCalls.push({
            name: block.name,
            input: inputStr,
            result: '',
          })
        }
      }
      break
    }

    case 'user': {
      const userEvent = event as StreamUserEvent
      const content = userEvent.message?.content

      if (content) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const pending = pendingToolUseIds.get(block.tool_use_id)
            if (pending) {
              // Find the matching tool call placeholder
              const tc = toolCalls.find(
                (t) =>
                  t.name === pending.name &&
                  t.input === pending.input &&
                  t.result === '',
              )
              if (tc) {
                tc.result =
                  typeof block.content === 'string'
                    ? block.content
                    : '(no output)'
              }
              pendingToolUseIds.delete(block.tool_use_id)
            }
          }
        }
      }

      // Also check top-level tool_use_result
      if (userEvent.tool_use_result) {
        const r = userEvent.tool_use_result
        const resultStr = r.stdout || r.stderr || '(no output)'
        const emptyTc = toolCalls.find((t) => t.result === '')
        if (emptyTc) {
          emptyTc.result = resultStr
        }
      }
      break
    }

    case 'result': {
      const resultEvent = event as StreamResultEvent
      const u = resultEvent.usage ?? {}
      setResult(
        resultEvent.result ?? '',
        {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        },
        Object.keys(resultEvent.modelUsage ?? {})[0] ?? 'claude-code',
      )
      break
    }
  }
}
