import type { ConversationSummary } from '@voice-coda/contracts'
import { Button } from '@voice-coda/ui/components/button'
import { Link } from 'react-router'

interface ConversationListProps {
  open: boolean
  conversations: ConversationSummary[]
  activeId: string | null
  onNew: () => void
  onDelete: (id: string) => void
  onClose: () => void
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function ConversationList({
  open,
  conversations,
  activeId,
  onNew,
  onDelete,
  onClose,
}: ConversationListProps) {
  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed top-0 left-0 z-50 h-full w-72 bg-background border-r border-border transform transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">History</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <title>Close</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18 18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* New conversation button */}
          <div className="px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                onNew()
                onClose()
              }}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <title>New conversation</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4.5v15m7.5-7.5h-15"
                />
              </svg>
              New conversation
            </Button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {conversations.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                No conversations yet
              </p>
            )}
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                to={`/c/${conv.id}`}
                onClick={onClose}
                className={`block w-full text-left rounded-lg px-3 py-2.5 mb-0.5 group transition-colors ${
                  conv.id === activeId
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm truncate flex-1">{conv.title}</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onDelete(conv.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive p-0.5 -mr-1 shrink-0"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                    >
                      <title>Delete</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                      />
                    </svg>
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatRelative(conv.updatedAt)} · {conv.messageCount} msg
                  {conv.messageCount !== 1 ? 's' : ''}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
