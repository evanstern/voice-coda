import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@voice-coda/server/trpc/router'

export function createServerTRPC(cookie: string) {
  const serverUrl = process.env.SERVER_URL
  if (!serverUrl) {
    throw new Error('SERVER_URL environment variable is required')
  }

  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${serverUrl}/trpc`,
        headers: () => (cookie ? { cookie } : {}),
      }),
    ],
  })
}
