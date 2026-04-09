import '@voice-coda/ui/styles/globals.css'
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router'
import type { Route } from './+types/root.js'
import { createServerTRPC } from './trpc/server.js'

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = context as { cookie?: string }
  const trpc = createServerTRPC(ctx.cookie ?? '')
  const [health, wsConfig, wakeWordConfig] = await Promise.all([
    trpc.health.check.query().catch(() => null),
    trpc.config.wsUrl.query().catch(() => null),
    trpc.config.wakeWord.query().catch(() => null),
  ])

  return { health, wsConfig, wakeWordConfig }
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function Root({ loaderData }: Route.ComponentProps) {
  return <Outlet context={loaderData} />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let status = 500
  let title = 'Internal Server Error'
  let message = 'Something went wrong. Please try again later.'

  if (isRouteErrorResponse(error)) {
    status = error.status
    if (status === 404) {
      title = 'Page Not Found'
      message =
        typeof error.data === 'string'
          ? error.data
          : 'The page you are looking for does not exist.'
    } else {
      message = typeof error.data === 'string' ? error.data : message
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <div className="max-w-md text-center space-y-4">
        <p className="text-6xl font-bold text-primary">{status}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}
