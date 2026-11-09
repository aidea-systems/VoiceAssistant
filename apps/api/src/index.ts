// The process: real dependencies from the environment, `serve` on PORT, graceful shutdown.
import { serve } from '@hono/node-server'
import Anthropic from '@anthropic-ai/sdk'

import { log } from '@va/core'

import { createApp } from './app.js'
import { landmarkConfig, parseApiEnv } from './env.js'
import { createMicrosoft } from './integrations/microsoft.js'
import { createRegistry } from './tools.js'
import { createLiveKit } from './voice/livekit.js'

const env = parseApiEnv(process.env)
const clock = () => new Date()
const microsoft = createMicrosoft(env, clock)
const app = createApp({
  anthropic: new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
  }),
  registry: createRegistry(microsoft?.tokens ?? null, landmarkConfig(env)),
  env,
  livekit: createLiveKit(env),
  microsoft,
  clock,
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log('info', '[api]', 'listening', {
    port: info.port,
    livekit: env.LIVEKIT_URL ? 'configured' : 'absent',
    microsoft: microsoft ? 'configured' : 'absent',
    landmark: landmarkConfig(env) ? 'configured' : 'absent',
  })
})

const shutdown = (signal: string): void => {
  log('info', '[api]', 'shutting down', { signal })
  server.close((err) => {
    if (err) log('error', '[api]', 'close failed', { reason: err.constructor.name })
    process.exit(err ? 1 : 0)
  })
  // Open streams get a grace period, then the process goes anyway.
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
