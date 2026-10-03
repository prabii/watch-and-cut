// Offline: open-weight models (Gemma 4 E2B/E4B by default) on a local Ollama server.
import { PLAN_JSON_SCHEMA } from './planSchema'
import { ProviderError, type ModelInfo, type ModelReply, type PlanRequest, type Provider } from './types'

const URL = () => process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const DEFAULT_MODEL = () => process.env.OLLAMA_MODEL || 'gemma4:e2b'
// Keep the model in memory between requests so only the first call pays the load time.
const KEEP_ALIVE = '30m'

export async function listOllamaModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${URL()}/api/tags`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new ProviderError(`Ollama error ${res.status}`)
  const json: any = await res.json()
  return (json.models ?? []).map((m: any) => ({
    id: m.name,
    label: m.name,
    detail: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined,
  }))
}

/** Load the model into memory ahead of the first real request (a cold load can take minutes). */
export async function warmOllama(model: string): Promise<void> {
  const res = await fetch(`${URL()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || DEFAULT_MODEL(), keep_alive: KEEP_ALIVE }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) throw new ProviderError(`Could not load ${model} (${res.status})`)
}

export const ollamaProvider: Provider = {
  async info() {
    const models = await listOllamaModels().catch(() => null)
    return {
      id: 'ollama',
      label: 'Ollama (offline)',
      kind: 'local',
      serverKey: false,
      needsKey: false,
      customBaseUrl: false,
      defaultModel: DEFAULT_MODEL(),
      models: models ?? [],
      available: models !== null,
      note: models === null ? 'Start Ollama on this computer to use offline models.' : 'Runs on this machine; video frames never leave it.',
    }
  },

  async plan(r: PlanRequest): Promise<ModelReply> {
    const res = await fetch(`${URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: r.model || DEFAULT_MODEL(),
        stream: false,
        // Ollama constrains decoding to this JSON schema.
        format: PLAN_JSON_SCHEMA,
        keep_alive: KEEP_ALIVE,
        options: { temperature: 0.4 },
        messages: [
          { role: 'system', content: r.system },
          { role: 'user', content: r.user, images: r.images },
        ],
      }),
      signal: AbortSignal.timeout(300_000),
    }).catch(() => {
      throw new ProviderError(`The offline model isn't running on this computer. Start Ollama and try again.`)
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new ProviderError(json?.error ?? `Ollama error ${res.status}`, res.status)
    const text = json?.message?.content
    if (!text) throw new ProviderError('Empty response from Ollama')
    return { text, model: r.model || DEFAULT_MODEL() }
  },
}
