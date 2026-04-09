import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@voice-coda/server/trpc/router'

let _client: ReturnType<typeof createTRPCClient<AppRouter>> | null = null

export function getClientTRPC() {
  if (_client) return _client

  const url = `${window.location.protocol}//${window.location.host}/trpc`

  _client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url })],
  })

  return _client
}
