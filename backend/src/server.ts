// Watch-and-Cut API. Forwards plan requests to the model the user picked:
// Gemma/Gemini, Claude, any OpenAI-compatible API, or a local Ollama model.
// Server-side keys come from backend/.env.local; a user's own key may arrive per request
// in the x-provider-key header and is used only for that request (never stored or logged).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env'
import { getProvider, listModels, PROVIDERS } from './providers'
import { warmOllama } from './providers/ollama'
import { ProviderError, type Credentials, type PlanRequest } from './providers/types'

loadEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..'))

const PORT = Number(process.env.PORT) || 8787
const MAX_BODY_BYTES = 25 * 1024 * 1024
const MAX_IMAGES = 16

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new ProviderError('Request too large', 413))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new ProviderError('Body is not valid JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function credentials(req: IncomingMessage): Credentials {
  const h = (name: string) => {
    const v = req.headers[name]
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined
  }
  return { apiKey: h('x-provider-key'), baseUrl: h('x-provider-base-url'), workspaceId: h('x-provider-workspace') }
}

function isPlanRequest(b: any): b is PlanRequest {
  return (
    b &&
    typeof b.provider === 'string' &&
    typeof b.model === 'string' &&
    typeof b.system === 'string' &&
    typeof b.user === 'string' &&
    Array.isArray(b.images) &&
    b.images.length <= MAX_IMAGES &&
    b.images.every((i: unknown) => typeof i === 'string')
  )
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      const infos = await Promise.all(Object.values(PROVIDERS).map((p) => p.info()))
      return send(res, 200, { providers: infos })
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      const models = await listModels(url.searchParams.get('provider') ?? '', credentials(req))
      return send(res, 200, { models })
    }

    if (req.method === 'POST' && url.pathname === '/api/warmup') {
      const body = (await readJson(req)) as { model?: string }
      const started = Date.now()
      await warmOllama(typeof body.model === 'string' ? body.model : '')
      console.log(`[warmup] ${body.model} loaded in ${Date.now() - started}ms`)
      return send(res, 200, { ok: true, ms: Date.now() - started })
    }

    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await readJson(req)
      if (!isPlanRequest(body)) return send(res, 400, { error: 'Invalid request body' })
      const started = Date.now()
      const reply = await getProvider(body.provider).plan(body, credentials(req))
      const ms = Date.now() - started
      console.log(`[plan] ${body.provider} ${reply.model} ${ms}ms, ${body.images.length} frames`)
      return send(res, 200, { ...reply, ms })
    }

    send(res, 404, { error: 'Not found' })
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 502
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[error] ${url.pathname} ${status}: ${message}`)
    send(res, status >= 400 && status < 600 ? status : 502, { error: message })
  }
})

server.listen(PORT, () => {
  const has = (k: string) => (process.env[k] ? 'key set' : 'no server key')
  console.log(`Watch-and-Cut API on http://localhost:${PORT}`)
  console.log(`  gemini:    ${has('GEMINI_API_KEY')}`)
  console.log(`  anthropic: ${has('ANTHROPIC_API_KEY')}`)
  console.log(`  openai:    ${has('OPENAI_API_KEY')} · ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`)
  console.log(`  ollama:    ${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'} · ${process.env.OLLAMA_MODEL || 'gemma4:e2b'}`)
})
