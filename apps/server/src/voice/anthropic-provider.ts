import { exec } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../logger.js'
import type { AIProvider, ChatParams, ChatResponse } from './ai-provider.js'

const log = logger.child({ module: 'claude' })

// --- Model routing ---

const MODEL_SONNET = 'claude-sonnet-4-6'
const MODEL_HAIKU = 'claude-haiku-4-5-20251001'

type ModelMode = 'auto' | 'sonnet' | 'haiku'

function getModelMode(): ModelMode {
  const env = process.env.CLAUDE_MODEL?.toLowerCase()
  if (env === 'sonnet' || env === 'haiku') return env
  return 'auto'
}

const HAIKU_TOOL_ESCALATION_THRESHOLD = 3

function pickModel(routingHint?: 'complex' | null): string {
  const mode = getModelMode()

  if (mode === 'sonnet') return MODEL_SONNET
  if (mode === 'haiku') return MODEL_HAIKU

  if (routingHint === 'complex') {
    return MODEL_SONNET
  }

  return MODEL_HAIKU
}

// --- Command blocklist ---

const WORK_DIR = process.env.WORK_DIR ?? process.cwd()

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /rm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/\s*$/,
    reason: 'Refusing to rm -rf /',
  },
  {
    pattern: /rm\s+-[^\s]*r[^\s]*f[^\s]*\s+~\s*$/,
    reason: 'Refusing to rm -rf home directory',
  },
  { pattern: /\bsudo\b/, reason: 'sudo is not allowed' },
  {
    pattern: /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/,
    reason: 'Piped remote execution is not allowed',
  },
  {
    pattern: /(^|\||\;|\&\&)\s*eval\s/,
    reason: 'eval is not allowed',
  },
  {
    pattern: /(^|\||\;|\&\&)\s*exec\s/,
    reason: 'exec is not allowed',
  },
  { pattern: /\bmkfs\b/, reason: 'mkfs is not allowed' },
  { pattern: /\bdd\s+if=/, reason: 'dd is not allowed' },
  {
    pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,
    reason: 'Fork bomb detected',
  },
  {
    pattern: /\bchmod\s+777\s+\//,
    reason: 'chmod 777 on system paths is not allowed',
  },
  {
    pattern: /\bchown\b.*\s+\/(bin|sbin|usr|etc|var|lib|boot|sys|proc|dev)\b/,
    reason: 'chown on system paths is not allowed',
  },
  {
    pattern: /^\s*>/,
    reason: 'Truncating files with > redirection is not allowed',
  },
]

function isCommandBlocked(cmd: string): string | null {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return reason
    }
  }
  return null
}

// --- Tools ---

const tools: Anthropic.Tool[] = [
  {
    name: 'run_shell',
    description:
      'Run a shell command and return stdout/stderr. Use for git commands, listing files, searching code, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the full text content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the file (relative to working directory or absolute)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

async function executeTool(
  name: string,
  input: Record<string, string>,
): Promise<string> {
  switch (name) {
    case 'run_shell': {
      const cmd = input.command ?? ''
      log.debug({ cmd }, 'tool run_shell')
      const blocked = isCommandBlocked(cmd)
      if (blocked) {
        log.warn({ cmd, reason: blocked }, 'blocked command')
        return `Error: ${blocked}`
      }
      try {
        const { stdout } = await execAsync(cmd, {
          cwd: WORK_DIR,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        })
        return stdout.trim() || '(no output)'
      } catch (err) {
        const e = err as { stderr?: string; message?: string }
        return `Error: ${e.stderr ?? e.message ?? 'unknown error'}`
      }
    }

    case 'read_file': {
      const filePath = input.path ?? ''
      const resolvedWorkDir = path.resolve(WORK_DIR)
      const resolved = path.resolve(WORK_DIR, filePath)
      if (!resolved.startsWith(resolvedWorkDir)) {
        return 'Error: access denied — path is outside the working directory'
      }
      log.debug({ path: resolved }, 'tool read_file')
      if (!existsSync(resolved)) {
        return `Error: file not found: ${resolved}`
      }
      try {
        return readFileSync(resolved, 'utf-8')
      } catch (err) {
        const e = err as { message?: string }
        return `Error: ${e.message ?? 'unknown error'}`
      }
    }

    default:
      return `Error: unknown tool "${name}"`
  }
}

// --- Provider ---

const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_SESSION_MESSAGES = 50
const SESSION_EVICTION_INTERVAL_MS = 5 * 60 * 1000

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'

  private client: Anthropic | null = null
  private sessions = new Map<string, Anthropic.MessageParam[]>()
  private sessionLastActive = new Map<string, number>()
  private evictionTimer: ReturnType<typeof setInterval>

  constructor() {
    this.evictionTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, lastActive] of this.sessionLastActive) {
        if (now - lastActive > SESSION_TTL_MS) {
          log.debug(
            {
              session: id.slice(0, 8),
              inactiveMin: Math.round((now - lastActive) / 1000 / 60),
            },
            'evicting stale session',
          )
          this.sessions.delete(id)
          this.sessionLastActive.delete(id)
        }
      }
    }, SESSION_EVICTION_INTERVAL_MS)
    this.evictionTimer.unref()
  }

  private getClient(): Anthropic {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('Missing ANTHROPIC_API_KEY environment variable')
      }
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    }
    return this.client
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { sessionId, userText, onToolUse } = params
    const anthropic = this.getClient()

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, [])
    }
    this.sessionLastActive.set(sessionId, Date.now())
    const messages = this.sessions.get(sessionId) ?? []
    messages.push({ role: 'user', content: userText })

    if (messages.length > MAX_SESSION_MESSAGES) {
      const excess = messages.length - MAX_SESSION_MESSAGES
      messages.splice(0, excess)
    }

    const toolCalls: ChatResponse['toolCalls'] = []
    const accumulatedUsage: ChatResponse['usage'] = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let continueCount = 0
    const MAX_CONTINUES = 3

    let model = pickModel(params.routingHint)
    log.info(
      { model, mode: getModelMode(), session: sessionId },
      'model routing',
    )

    const MAX_RETRIES = 3
    const createWithRetry = async (
      apiParams: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await anthropic.messages.create(apiParams)
        } catch (err) {
          const status = (err as { status?: number }).status
          if ((status === 429 || status === 529) && attempt < MAX_RETRIES) {
            const delay = 1000 * 2 ** (attempt - 1)
            log.warn(
              { status, attempt, maxRetries: MAX_RETRIES, delayMs: delay },
              'rate limit error, retrying',
            )
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          throw err
        }
      }
    }

    while (continueCount <= MAX_CONTINUES) {
      try {
        let iterations = 0
        const MAX_ITERATIONS = 20

        while (iterations < MAX_ITERATIONS) {
          iterations++

          log.debug(
            { model, iteration: iterations, continueCount },
            'sending API request',
          )
          const response = await createWithRetry({
            model,
            max_tokens: 4096,
            system: params.voiceContext
              ? [
                  {
                    type: 'text',
                    text: params.voiceContext.systemPrompt,
                    cache_control: { type: 'ephemeral' },
                  },
                ]
              : [],
            tools,
            messages,
          })

          const cacheRead = response.usage.cache_read_input_tokens ?? 0
          const cacheCreation = response.usage.cache_creation_input_tokens ?? 0
          if (cacheRead > 0 || cacheCreation > 0) {
            log.debug(
              {
                cacheRead,
                cacheCreation,
                inputTokens: response.usage.input_tokens,
              },
              'cache stats',
            )
          }

          messages.push({ role: 'assistant', content: response.content })

          accumulatedUsage.input_tokens += response.usage.input_tokens
          accumulatedUsage.output_tokens += response.usage.output_tokens
          accumulatedUsage.cache_creation_input_tokens +=
            response.usage.cache_creation_input_tokens ?? 0
          accumulatedUsage.cache_read_input_tokens +=
            response.usage.cache_read_input_tokens ?? 0

          if (response.stop_reason === 'end_turn') {
            const textBlock = response.content.find(
              (b): b is Anthropic.TextBlock => b.type === 'text',
            )
            const text = textBlock?.text ?? ''
            log.info(
              { iterations, continueCount, textLength: text.length },
              'response complete',
            )
            return { text, toolCalls, usage: accumulatedUsage, model }
          }

          if (response.stop_reason === 'tool_use') {
            if (
              model === MODEL_HAIKU &&
              getModelMode() === 'auto' &&
              iterations >= HAIKU_TOOL_ESCALATION_THRESHOLD
            ) {
              log.info(
                { iterations },
                'Haiku hit tool iteration threshold, escalating to Sonnet',
              )
              model = MODEL_SONNET
            }

            const toolUseBlocks = response.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            )

            const toolResults: Anthropic.ToolResultBlockParam[] = []

            for (const tool of toolUseBlocks) {
              const input = tool.input as Record<string, string>
              const inputStr = JSON.stringify(input)
              onToolUse?.(tool.name, inputStr)

              const result = await executeTool(tool.name, input)
              const truncated =
                result.length > 10_000
                  ? `${result.slice(0, 10_000)}\n... (truncated, ${result.length} chars total)`
                  : result

              toolCalls.push({
                name: tool.name,
                input: inputStr,
                result: truncated,
              })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tool.id,
                content: truncated,
              })
            }

            messages.push({ role: 'user', content: toolResults })
            continue
          }

          const textBlock = response.content.find(
            (b): b is Anthropic.TextBlock => b.type === 'text',
          )
          return {
            text: textBlock?.text ?? '',
            toolCalls,
            usage: accumulatedUsage,
            model,
          }
        }

        return {
          text: 'I hit the maximum number of tool iterations. Could you try a simpler request?',
          toolCalls,
          usage: accumulatedUsage,
          model,
        }
      } catch (err) {
        const error = err as {
          message?: string
          error?: { type?: string; message?: string }
        }
        const errorMessage =
          error.error?.message ?? error.message ?? 'Unknown error'

        if (
          errorMessage.includes('maximum number of tool') ||
          errorMessage.includes('too many tool calls') ||
          error.error?.type === 'invalid_request_error'
        ) {
          continueCount++
          log.warn(
            { continueCount, maxContinues: MAX_CONTINUES },
            'hit API tool limit, auto-continuing',
          )

          if (continueCount > MAX_CONTINUES) {
            return {
              text: `I've made a lot of progress but need to stop here. I completed ${toolCalls.length} operations. Please ask me to continue if you'd like me to finish.`,
              toolCalls,
              usage: accumulatedUsage,
              model,
            }
          }

          messages.push({
            role: 'user',
            content: 'Please continue with the remaining tasks.',
          })
          continue
        }

        throw err
      }
    }

    return {
      text: 'Completed the available operations.',
      toolCalls,
      usage: accumulatedUsage,
      model,
    }
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.sessionLastActive.delete(sessionId)
  }

  getExternalSessionId(_sessionId: string): string | null {
    return null
  }

  setExternalSessionId(_sessionId: string, _externalSessionId: string): void {}

  restoreSession(
    sessionId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): void {
    const messages: Anthropic.MessageParam[] = []
    for (const msg of history) {
      if (msg.content) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
    this.sessions.set(sessionId, messages)
    log.info(
      { session: sessionId.slice(0, 8), messageCount: messages.length },
      'session restored',
    )
  }
}
