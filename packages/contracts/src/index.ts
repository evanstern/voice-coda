import { z } from 'zod/v4'

export const heartbeatResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.iso.datetime(),
})

export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>

// ── Chat History ────────────────────────────────────────────────

export const toolCallSchema = z.object({
  name: z.string(),
  input: z.string(),
  result: z.string(),
})

export type ToolCall = z.infer<typeof toolCallSchema>

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.iso.datetime(),
  error: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  model: z.string().optional(),
})

export type Message = z.infer<typeof messageSchema>

export const conversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messageCount: z.number(),
})

export type ConversationSummary = z.infer<typeof conversationSummarySchema>

// ── Client → Server WebSocket Messages ─────────────────────────

export const setConversationMessage = z.object({
  type: z.literal('set_conversation'),
  conversationId: z.string().nullable(),
  isFirstMessage: z.boolean().optional(),
})

export type SetConversationMessage = z.infer<typeof setConversationMessage>

export const controlMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('detect_wake') }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('ping') }),
])

export type ControlMessage = z.infer<typeof controlMessage>

export const clientWsMessage = z.union([setConversationMessage, controlMessage])

export type ClientWsMessage = z.infer<typeof clientWsMessage>

// ── Server → Client WebSocket Messages ────────────────────────

export const audioAckMessage = z.object({
  type: z.literal('audio_ack'),
  chunk: z.number(),
  bytes: z.number(),
  totalBytes: z.number(),
})

export type AudioAckMessage = z.infer<typeof audioAckMessage>

export const transcribingMessage = z.object({
  type: z.literal('transcribing'),
  bytes: z.number(),
})

export type TranscribingMessage = z.infer<typeof transcribingMessage>

export const transcriptionMessage = z.object({
  type: z.literal('transcription'),
  text: z.string().optional(),
  error: z.string().optional(),
})

export type TranscriptionMessage = z.infer<typeof transcriptionMessage>

export const thinkingMessage = z.object({
  type: z.literal('thinking'),
})

export type ThinkingMessage = z.infer<typeof thinkingMessage>

export const toolUseMessage = z.object({
  type: z.literal('tool_use'),
  name: z.string(),
})

export type ToolUseMessage = z.infer<typeof toolUseMessage>

export const aiResponseMessage = z.object({
  type: z.literal('ai_response'),
  text: z.string().optional(),
  error: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
})

export type AIResponseMessage = z.infer<typeof aiResponseMessage>

export const synthesizingMessage = z.object({
  type: z.literal('synthesizing'),
})

export type SynthesizingMessage = z.infer<typeof synthesizingMessage>

export const ttsAudioMessage = z.object({
  type: z.literal('tts_audio'),
  format: z.string(),
  bytes: z.number(),
})

export type TtsAudioMessage = z.infer<typeof ttsAudioMessage>

export const ttsErrorMessage = z.object({
  type: z.literal('tts_error'),
  error: z.string(),
})

export type TtsErrorMessage = z.infer<typeof ttsErrorMessage>

export const commandMessage = z.object({
  type: z.literal('command'),
  command: z.string(),
})

export type CommandMessage = z.infer<typeof commandMessage>

export const errorMessage = z.object({
  type: z.literal('error'),
  error: z.string(),
})

export type ErrorMessage = z.infer<typeof errorMessage>

export const wakeDetectionMessage = z.object({
  type: z.literal('wake_detection'),
  detected: z.boolean(),
  text: z.string().optional(),
})

export type WakeDetectionMessage = z.infer<typeof wakeDetectionMessage>

export const conversationUpdatedMessage = z.object({
  type: z.literal('conversation_updated'),
  conversationId: z.string(),
})

export type ConversationUpdatedMessage = z.infer<
  typeof conversationUpdatedMessage
>

export const processingPendingMessage = z.object({
  type: z.literal('processing_pending'),
  conversationId: z.string(),
})

export type ProcessingPendingMessage = z.infer<typeof processingPendingMessage>

export const serverWsMessage = z.discriminatedUnion('type', [
  audioAckMessage,
  transcribingMessage,
  transcriptionMessage,
  thinkingMessage,
  toolUseMessage,
  aiResponseMessage,
  synthesizingMessage,
  ttsAudioMessage,
  ttsErrorMessage,
  commandMessage,
  errorMessage,
  wakeDetectionMessage,
  conversationUpdatedMessage,
  processingPendingMessage,
])

export type ServerWsMessage = z.infer<typeof serverWsMessage>
