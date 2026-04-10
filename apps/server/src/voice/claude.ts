// Thin wrapper that delegates to the configured AI provider.

import {
  type ChatParams,
  type ChatResponse,
  getAIProvider,
} from './ai-provider.js'
import type { VoiceContext } from './voice-context.js'

export async function chat(
  sessionId: string,
  userText: string,
  onToolUse?: (name: string, input: string) => void,
  signal?: AbortSignal,
  voiceContext?: VoiceContext,
  routingHint?: ChatParams['routingHint'],
): Promise<ChatResponse> {
  return getAIProvider().chat({
    sessionId,
    userText,
    voiceContext,
    routingHint,
    onToolUse,
    signal,
  })
}

export function clearSession(sessionId: string): void {
  getAIProvider().clearSession(sessionId)
}

export function getExternalSessionId(sessionId: string): string | null {
  return getAIProvider().getExternalSessionId(sessionId)
}

export function setExternalSessionId(
  sessionId: string,
  externalSessionId: string,
): void {
  getAIProvider().setExternalSessionId(sessionId, externalSessionId)
}

export function restoreSession(
  sessionId: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): void {
  getAIProvider().restoreSession(sessionId, history)
}
