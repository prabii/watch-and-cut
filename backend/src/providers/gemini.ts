import { ProviderError, type Credentials, type ModelInfo, type ModelReply, type PlanRequest, type Provider } from './types'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = () => process.env.GEMINI_MODEL || 'gemma-4-31b-it'

function key(creds: Credentials) {
  return creds.apiKey || process.env.GEMINI_API_KEY || ''
}

/** Live list of models that can generate content (Gemma first, since that's the hackathon track). */
export async function listGeminiModels(creds: Credentials): Promise<ModelInfo[]> {
  const k = key(creds)
  if (!k) return [{ id: DEFAULT_MODEL(), label: DEFAULT_MODEL() }]
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': k }, signal: AbortSignal.timeout(10_000) })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new ProviderError(json?.error?.message ?? `Gemini API error ${res.status}`, res.status)
  return (json.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name }))
    .sort((a: ModelInfo, b: ModelInfo) => Number(b.id.startsWith('gemma')) - Number(a.id.startsWith('gemma')))
}

export const geminiProvider: Provider = {
  async info() {
    return {
      id: 'gemini',
      label: 'Gemma / Gemini (Google)',
      kind: 'cloud',
      serverKey: Boolean(process.env.GEMINI_API_KEY),
      needsKey: true,
      customBaseUrl: false,
      defaultModel: DEFAULT_MODEL(),
      models: [{ id: DEFAULT_MODEL(), label: DEFAULT_MODEL() }],
      available: true,
      note: "Google's open Gemma 4 models (and Gemini) through the Gemini API.",
    }
  },

  async plan(r: PlanRequest, creds: Credentials): Promise<ModelReply> {
    const k = key(creds)
    if (!k) throw new ProviderError('Add a Google AI Studio API key in model settings to use Gemma.', 400)
    // Gemma models may not accept a separate system instruction, so it is folded into the user turn.
    const parts = [
      { text: `${r.system}\n\n${r.user}` },
      ...r.images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })),
    ]
    const res = await fetch(`${BASE}/models/${encodeURIComponent(r.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new ProviderError(json?.error?.message ?? `Gemini API error ${res.status}`, res.status)
    const text = (json?.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => typeof p.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('')
    if (!text) throw new ProviderError('Empty response from the Gemini API')
    return { text, model: r.model }
  },
}
