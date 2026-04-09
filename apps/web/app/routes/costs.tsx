import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@voice-coda/ui/components/card'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getClientTRPC } from '../trpc/client.js'

interface ServiceCosts {
  stt: number
  llm: number
  tts: number
}

interface SessionSummary {
  sessionId: string
  interactions: number
  totalCost: number
  costs: ServiceCosts
}

interface ProviderModelEntry {
  provider: string
  model: string
  cost: number
  count: number
}

interface CostHistory {
  totalInteractions: number
  totalCost: number
  avgCostPerInteraction: number
  costBreakdown: ServiceCosts
  usage: {
    sttDurationSec: number
    llmInputTokens: number
    llmOutputTokens: number
    llmCacheReadTokens: number
    llmCacheWriteTokens: number
    ttsChars: number
  }
  byProviderModel: ProviderModelEntry[]
  periodStart: string
  periodEnd: string
}

interface SessionStats {
  sessions: SessionSummary[]
  activeSessions: number
}

type Period = 'today' | '7d' | '30d' | 'all'

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'all', label: 'All Time' },
]

function getPeriodRange(period: Period): { from: string; to: string } {
  const now = new Date()
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  )
  const to = endOfDay.toISOString()

  switch (period) {
    case 'today': {
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      )
      return { from: startOfDay.toISOString(), to }
    }
    case '7d': {
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 6,
      )
      return { from: start.toISOString(), to }
    }
    case '30d': {
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 29,
      )
      return { from: start.toISOString(), to }
    }
    case 'all':
      return { from: '2000-01-01T00:00:00.000Z', to }
  }
}

function periodLabel(period: Period): string {
  switch (period) {
    case 'today':
      return new Date().toLocaleDateString()
    case '7d':
      return 'Last 7 days'
    case '30d':
      return 'Last 30 days'
    case 'all':
      return 'All time'
  }
}

export function meta() {
  return [
    { title: 'Costs | Voice Assistant' },
    { name: 'description', content: 'API usage costs and breakdown' },
  ]
}

function formatCost(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs.toFixed(0)}s`
}

function providerColor(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'bg-violet-500'
    case 'openai':
      return 'bg-emerald-500'
    case 'google':
      return 'bg-blue-500'
    case 'local':
    case 'piper':
      return 'bg-gray-500'
    default:
      return 'bg-amber-500'
  }
}

function CostBar({
  label,
  cost,
  total,
  color,
  detail,
}: {
  label: string
  cost: number
  total: number
  color: string
  detail?: string
}) {
  const pct = total > 0 ? (cost / total) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {label}
          {detail && <span className="ml-2 text-xs opacity-60">{detail}</span>}
        </span>
        <span className="font-mono font-medium text-foreground">
          {formatCost(cost)}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  )
}

export default function Costs() {
  const [history, setHistory] = useState<CostHistory | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('today')

  const trpc = typeof window === 'undefined' ? null : getClientTRPC()

  const fetchData = useCallback(async () => {
    if (!trpc) return
    try {
      const range = getPeriodRange(period)
      const [historyData, statsData] = await Promise.all([
        trpc.costHistory.query(range),
        trpc.stats.query(),
      ])
      setHistory(historyData)
      setSessionStats({
        sessions: statsData.sessions,
        activeSessions: statsData.activeSessions,
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch stats')
    } finally {
      setLoading(false)
    }
  }, [trpc, period])

  useEffect(() => {
    setLoading(true)
    fetchData()
    const interval = setInterval(fetchData, 10_000)
    return () => clearInterval(interval)
  }, [fetchData])

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 flex items-center justify-between px-4 py-3 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="text-muted-foreground hover:text-foreground transition-colors p-1 -ml-1"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <title>Back</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 19.5L8.25 12l7.5-7.5"
              />
            </svg>
          </Link>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Costs
          </h1>
        </div>
        <span className="text-xs text-muted-foreground">
          {periodLabel(period)}
        </span>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Period Selector */}
        <div className="flex gap-1 p-1 rounded-lg bg-muted">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                period === p.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {history && !loading && (
          <>
            {/* Total Cost */}
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Spend</CardDescription>
                <CardTitle className="text-3xl font-mono">
                  {formatCost(history.totalCost)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4 text-sm text-muted-foreground">
                  <span>{history.totalInteractions} interactions</span>
                  {sessionStats && (
                    <>
                      <span className="text-border">|</span>
                      <span>
                        {sessionStats.activeSessions} active session
                        {sessionStats.activeSessions !== 1 ? 's' : ''}
                      </span>
                    </>
                  )}
                  <span className="text-border">|</span>
                  <span>{formatCost(history.avgCostPerInteraction)} avg</span>
                </div>
              </CardContent>
            </Card>

            {/* Cost Breakdown by Service */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cost by Service</CardTitle>
                <CardDescription>
                  Breakdown across API providers
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <CostBar
                  label="LLM"
                  cost={history.costBreakdown.llm}
                  total={history.totalCost}
                  color="bg-violet-500"
                />
                <CostBar
                  label="Speech-to-Text (OpenAI Whisper)"
                  cost={history.costBreakdown.stt}
                  total={history.totalCost}
                  color="bg-emerald-500"
                />
                <CostBar
                  label="Text-to-Speech (OpenAI TTS)"
                  cost={history.costBreakdown.tts}
                  total={history.totalCost}
                  color="bg-amber-500"
                />
              </CardContent>
            </Card>

            {/* Cost by Provider & Model */}
            {history.byProviderModel.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Cost by Provider & Model
                  </CardTitle>
                  <CardDescription>
                    Breakdown by AI provider and model
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {history.byProviderModel.map((entry) => (
                    <CostBar
                      key={`${entry.provider}:${entry.model}`}
                      label={`${entry.provider} / ${entry.model}`}
                      cost={entry.cost}
                      total={history.totalCost}
                      color={providerColor(entry.provider)}
                      detail={`${formatNumber(entry.count)} calls`}
                    />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Usage Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Usage Details</CardTitle>
                <CardDescription>Raw consumption metrics</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <div className="space-y-3">
                    <div>
                      <p className="text-muted-foreground">STT Duration</p>
                      <p className="font-mono font-medium">
                        {formatDuration(history.usage.sttDurationSec)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">LLM Input Tokens</p>
                      <p className="font-mono font-medium">
                        {formatNumber(history.usage.llmInputTokens)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">LLM Output Tokens</p>
                      <p className="font-mono font-medium">
                        {formatNumber(history.usage.llmOutputTokens)}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-muted-foreground">TTS Characters</p>
                      <p className="font-mono font-medium">
                        {formatNumber(history.usage.ttsChars)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Cache Read Tokens</p>
                      <p className="font-mono font-medium">
                        {formatNumber(history.usage.llmCacheReadTokens)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">
                        Cache Write Tokens
                      </p>
                      <p className="font-mono font-medium">
                        {formatNumber(history.usage.llmCacheWriteTokens)}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Active Sessions */}
            {sessionStats && sessionStats.sessions.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Active Sessions</CardTitle>
                  <CardDescription>
                    {sessionStats.sessions.length} session
                    {sessionStats.sessions.length !== 1 ? 's' : ''} with tracked
                    costs
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {sessionStats.sessions.map((session) => (
                      <div
                        key={session.sessionId}
                        className="flex items-center justify-between py-2 border-b border-border last:border-0"
                      >
                        <div>
                          <p className="font-mono text-sm text-foreground">
                            {session.sessionId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {session.interactions} interaction
                            {session.interactions !== 1 ? 's' : ''}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-sm font-medium">
                            {formatCost(session.totalCost)}
                          </p>
                          <div className="flex gap-2 text-[10px] text-muted-foreground">
                            <span className="text-violet-400">
                              L:{formatCost(session.costs.llm)}
                            </span>
                            <span className="text-emerald-400">
                              S:{formatCost(session.costs.stt)}
                            </span>
                            <span className="text-amber-400">
                              T:{formatCost(session.costs.tts)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Refresh */}
            <div className="flex justify-center pb-4">
              <button
                type="button"
                onClick={fetchData}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Auto-refreshes every 10s
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
