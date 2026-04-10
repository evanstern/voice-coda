import { logger } from '../logger.js'
import { AnthropicProvider } from './anthropic-provider.js'
import { ClaudeCodeProvider } from './claude-code-provider.js'
import { OpenCodeProvider } from './opencode-provider.js'
import type { VoiceContext } from './voice-context.js'

const log = logger.child({ module: 'ai' })

export interface AIProvider {
  readonly name: string
  chat(params: ChatParams): Promise<ChatResponse>
  clearSession(sessionId: string): void
  restoreSession(
    sessionId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): void
  getExternalSessionId?(sessionId: string): string | undefined
  setExternalSessionId?(sessionId: string, externalId: string): void
}

export interface ChatParams {
  sessionId: string
  userText: string
  voiceContext?: VoiceContext
  routingHint?: 'complex' | null
  onToolUse?: (name: string, input: string) => void
  signal?: AbortSignal
}

export interface ChatResponse {
  text: string
  toolCalls: Array<{ name: string; input: string; result: string }>
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  model: string
  /** Upstream provider identifier (e.g. "anthropic", "openai") when available. */
  providerID?: string
  /** Cost reported by the upstream provider/harness. When set and > 0, used instead of token-based estimation. */
  reportedCost?: number
}

// --- Provider factory ---

const providers: Record<string, () => AIProvider> = {
  anthropic: () => new AnthropicProvider(),
  'claude-code': () => new ClaudeCodeProvider(),
  opencode: () => new OpenCodeProvider(),
}

let cached: AIProvider | null = null

export function getAIProvider(): AIProvider {
  if (cached) return cached

  const name = process.env.AI_PROVIDER ?? 'anthropic'
  const factory = providers[name]

  if (!factory) {
    const available = Object.keys(providers).join(', ')
    throw new Error(`Unknown AI_PROVIDER "${name}". Available: ${available}`)
  }

  cached = factory()
  log.info({ provider: cached.name }, 'using AI provider')
  return cached
}
