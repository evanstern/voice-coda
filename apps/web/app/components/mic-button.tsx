import { useRef } from 'react'

import { PHASE_HINTS } from '../constants/phase-labels.js'

type InputMode = 'push-to-talk' | 'auto' | 'wake-word'

interface MicButtonProps {
  phase: string
  connected: boolean
  busy: boolean
  mode: InputMode
  onStart: () => void
  onStop: () => void
  onCancel: () => void
  onToggleMode: () => void
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <title>Microphone</title>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
      />
    </svg>
  )
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <title>Stop</title>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z"
      />
    </svg>
  )
}

function CancelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <title>Cancel</title>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 18 18 6M6 6l12 12"
      />
    </svg>
  )
}

export function MicButton({
  phase,
  connected,
  busy,
  mode,
  onStart,
  onStop,
  onCancel,
  onToggleMode,
}: MicButtonProps) {
  const isRecording = phase === 'recording'
  const isPassiveListening = phase === 'passive-listening'
  const isPushToTalk = mode === 'push-to-talk'
  const isAuto = mode === 'auto'
  const isWakeWord = mode === 'wake-word'
  const hints = PHASE_HINTS[mode] ?? PHASE_HINTS['push-to-talk'] ?? {}
  const holdEndRef = useRef(0)

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!isPushToTalk) return
    if (busy || isRecording || !connected) return
    e.currentTarget.setPointerCapture(e.pointerId)
    onStart()
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!isPushToTalk) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (isRecording) {
      holdEndRef.current = Date.now()
      onStop()
    }
  }

  const handleClick = () => {
    if (isPushToTalk) {
      if (Date.now() - holdEndRef.current < 400) return
      if (busy) {
        onCancel()
      }
      return
    }

    if (busy) {
      onCancel()
    } else if (isRecording) {
      onStop()
    } else {
      onStart()
    }
  }

  return (
    <div className="sticky bottom-0 z-20 flex flex-col items-center gap-2 pb-6 pt-3 bg-gradient-to-t from-background via-background to-transparent">
      <span className="text-xs text-muted-foreground">
        {!connected
          ? 'Connecting...'
          : (hints[phase] ?? hints.idle ?? 'Tap or hold space')}
      </span>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={(e) => e.preventDefault()}
          onClick={handleClick}
          disabled={!connected}
          style={{
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
          className={`relative inline-flex items-center justify-center w-16 h-16 rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed ${
            isRecording
              ? 'bg-red-500/20 border-2 border-red-500 text-red-400 scale-110'
              : busy
                ? 'bg-orange-500/10 border-2 border-orange-500/40 text-orange-400 hover:bg-orange-500/20 active:scale-95'
                : isPassiveListening
                  ? 'bg-emerald-500/10 border-2 border-emerald-500/40 text-emerald-400'
                  : (isAuto || isWakeWord) &&
                      (phase === 'idle' || phase === 'done')
                    ? 'bg-green-500/10 border-2 border-green-500/40 text-green-400 hover:bg-green-500/20'
                    : 'bg-primary/10 border-2 border-primary/40 text-primary hover:bg-primary/20 hover:border-primary/60 active:scale-95'
          }`}
        >
          {isRecording && (
            <span className="absolute inset-0 rounded-full animate-pulse-ring bg-red-500/20" />
          )}
          {isPassiveListening && (
            <span className="absolute inset-0 rounded-full animate-pulse bg-emerald-500/10" />
          )}
          {(isAuto || isWakeWord) &&
            !isRecording &&
            !busy &&
            !isPassiveListening && (
              <span className="absolute inset-0 rounded-full animate-pulse bg-green-500/5" />
            )}
          {busy && (
            <span className="absolute inset-0 rounded-full animate-pulse bg-orange-500/10" />
          )}
          {busy ? (
            <CancelIcon className="w-7 h-7 relative z-10" />
          ) : isRecording ? (
            <StopIcon className="w-7 h-7 relative z-10" />
          ) : (
            <MicIcon className="w-7 h-7 relative z-10" />
          )}
        </button>
      </div>
      <button
        type="button"
        onClick={onToggleMode}
        className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        {mode === 'wake-word'
          ? 'Switch to tap-to-talk'
          : mode === 'auto'
            ? 'Switch to wake-word'
            : 'Switch to auto'}
      </button>
    </div>
  )
}
