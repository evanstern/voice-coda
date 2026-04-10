/**
 * Phase hint labels shown below the mic button, varying by input mode.
 */
export const PHASE_HINTS: Record<string, Record<string, string>> = {
  'push-to-talk': {
    idle: 'Hold to talk',
    'passive-listening': 'Hold to talk',
    recording: 'Release to send',
    transcribing: 'Tap to cancel',
    thinking: 'Tap to cancel',
    synthesizing: 'Tap to cancel',
    speaking: 'Tap to stop',
    done: 'Hold to talk',
  },
  auto: {
    idle: 'Say “Coda”',
    'passive-listening': 'Say “Coda”',
    recording: 'Speak now...',
    transcribing: 'Tap to cancel',
    thinking: 'Tap to cancel',
    synthesizing: 'Tap to cancel',
    speaking: 'Tap to stop',
    done: 'Say “Coda”',
  },
  'wake-word': {
    idle: 'Connecting to wake-word...',
    'passive-listening': 'Say "Coda" to activate',
    recording: 'Speak now...',
    transcribing: 'Processing...',
    thinking: 'Tap to cancel',
    synthesizing: 'Tap to cancel',
    speaking: 'Tap to stop',
    done: 'Returning to passive...',
  },
}

/**
 * Status indicator labels and styling for each processing phase.
 * Used by the status indicator bubble shown during active processing.
 */
export const STATUS_PHASE_CONFIG: Record<
  string,
  { label: string; colorClass: string; showTimer: boolean }
> = {
  'passive-listening': {
    label: 'Listening for "Coda"...',
    colorClass: 'bg-emerald-500',
    showTimer: false,
  },
  recording: {
    label: 'Listening...',
    colorClass: 'bg-red-500',
    showTimer: false,
  },
  transcribing: {
    label: 'Transcribing...',
    colorClass: 'bg-primary',
    showTimer: false,
  },
  thinking: {
    label: 'Thinking...',
    colorClass: 'bg-primary',
    showTimer: true,
  },
  synthesizing: {
    label: 'Generating speech...',
    colorClass: 'bg-primary',
    showTimer: true,
  },
  speaking: {
    label: 'Speaking...',
    colorClass: 'bg-green-500',
    showTimer: false,
  },
}
