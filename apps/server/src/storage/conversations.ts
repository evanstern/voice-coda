import { randomUUID } from 'node:crypto'
import {
  access,
  appendFile,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationSummary, Message } from '@voice-coda/contracts'

const DATA_DIR = join(process.cwd(), 'data', 'conversations')
const INDEX_FILE = join(DATA_DIR, 'index.jsonl')

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureDataDir() {
  if (!(await fileExists(DATA_DIR))) {
    await mkdir(DATA_DIR, { recursive: true })
  }
  if (!(await fileExists(INDEX_FILE))) {
    await writeFile(INDEX_FILE, '')
  }
}

function convFile(id: string): string {
  return join(DATA_DIR, `conv_${id}.jsonl`)
}

async function readJsonlLines<T>(filePath: string): Promise<T[]> {
  if (!(await fileExists(filePath))) return []
  const content = (await readFile(filePath, 'utf-8')).trim()
  if (!content) return []
  return content.split('\n').map((line) => JSON.parse(line) as T)
}

async function appendJsonl(filePath: string, obj: unknown) {
  await appendFile(filePath, `${JSON.stringify(obj)}\n`)
}

async function rewriteIndex(entries: ConversationSummary[]) {
  await writeFile(
    INDEX_FILE,
    entries.map((e) => JSON.stringify(e)).join('\n') +
      (entries.length ? '\n' : ''),
  )
}

// ── Public API ──────────────────────────────────────────────────

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureDataDir()
  return (await readJsonlLines<ConversationSummary>(INDEX_FILE)).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )
}

export async function createConversation(
  title?: string,
): Promise<ConversationSummary> {
  await ensureDataDir()
  const now = new Date().toISOString()
  const summary: ConversationSummary = {
    id: randomUUID(),
    title: title ?? 'New conversation',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }
  await appendJsonl(INDEX_FILE, summary)
  await writeFile(convFile(summary.id), '')
  return summary
}

export async function getConversation(
  id: string,
): Promise<{ summary: ConversationSummary; messages: Message[] } | null> {
  await ensureDataDir()
  const entries = await readJsonlLines<ConversationSummary>(INDEX_FILE)
  const summary = entries.find((e) => e.id === id)
  if (!summary) return null
  const messages = await readJsonlLines<Message>(convFile(id))
  return { summary, messages }
}

export async function appendMessage(
  conversationId: string,
  message: Omit<Message, 'id' | 'timestamp'>,
): Promise<Message> {
  await ensureDataDir()
  const full: Message = {
    ...message,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  await appendJsonl(convFile(conversationId), full)

  // Update index entry
  const entries = await readJsonlLines<ConversationSummary>(INDEX_FILE)
  const idx = entries.findIndex((e) => e.id === conversationId)
  const entry = entries[idx]
  if (entry) {
    entry.messageCount++
    entry.updatedAt = full.timestamp
    await rewriteIndex(entries)
  }

  return full
}

export async function deleteConversation(id: string): Promise<boolean> {
  await ensureDataDir()
  const entries = await readJsonlLines<ConversationSummary>(INDEX_FILE)
  const filtered = entries.filter((e) => e.id !== id)
  if (filtered.length === entries.length) return false
  await rewriteIndex(filtered)
  const file = convFile(id)
  if (await fileExists(file)) await unlink(file)
  return true
}

export async function updateConversationTitle(
  id: string,
  title: string,
): Promise<boolean> {
  await ensureDataDir()
  const entries = await readJsonlLines<ConversationSummary>(INDEX_FILE)
  const idx = entries.findIndex((e) => e.id === id)
  const entry = entries[idx]
  if (!entry) return false
  entry.title = title
  entry.updatedAt = new Date().toISOString()
  await rewriteIndex(entries)
  return true
}

export async function autoTitle(
  conversationId: string,
  firstUserMessage: string,
) {
  const title =
    firstUserMessage.slice(0, 60) +
    (firstUserMessage.length > 60 ? '\u2026' : '')
  await updateConversationTitle(conversationId, title)
}

export async function getAISessionId(
  conversationId: string,
): Promise<string | null> {
  await ensureDataDir()
  const entries = await readJsonlLines<ConversationSummary>(INDEX_FILE)
  const entry = entries.find(
    (conversation) => conversation.id === conversationId,
  )
  return entry?.aiSessionId ?? null
}

export async function updateAISessionId(
  conversationId: string,
  aiSessionId: string,
): Promise<boolean> {
  await ensureDataDir()
  const entries = await readJsonlLines<ConversationSummary>(INDEX_FILE)
  const entry = entries.find(
    (conversation) => conversation.id === conversationId,
  )
  if (!entry) return false
  entry.aiSessionId = aiSessionId
  entry.updatedAt = new Date().toISOString()
  await rewriteIndex(entries)
  return true
}
