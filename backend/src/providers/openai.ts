// Any OpenAI-compatible Chat Completions API: OpenAI, OpenRouter, Groq, Together,
// Mistral, LM Studio, vLLM… The model must accept image input.
import { ProviderError, type Credentials, type ModelInfo, type ModelReply, type PlanRequest, type Provider } from './types'

const DEFAULT_BASE = () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

function baseUrl(creds: Credentials) {
  const url = (creds.baseUrl || DEFAULT_BASE()).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) throw new ProviderError('Base URL must start with http:// or https://', 400)
  return url
}

function headers(creds: Credentials) {
  const k = creds.apiKey || process.env.OPENAI_API_KEY
  return { 'Content-Type': 'application/json', ...(k ? { Authorization: `Bearer ${k}` } : {}) }
}

export async function listOpenAIModels(creds: Credentials): Promise<ModelInfo[]> {
  const res = await fetch(`${baseUrl(creds)}/models`, { headers: headers(creds), signal: AbortSignal.timeout(10_000) })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new ProviderError(json?.error?.message ?? `Model list failed (${res.status})`, res.status)
  return (json.data ?? []).map((m: any) => ({ id: m.id, label: m.id })).sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id))
}

export const openaiProvider: Provider = {
  async info() {
    return {
      id: 'openai',
      label: 'OpenAI-compatible',
      kind: 'cloud',
      serverKey: Boolean(process.env.OPENAI_API_KEY),
      needsKey: true,
      customBaseUrl: true,
      defaultModel: process.env.OPENAI_MODEL || '',
      models: process.env.OPENAI_MODEL ? [{ id: process.env.OPENAI_MODEL, label: process.env.OPENAI_MODEL }] : [],
      available: true,
      note: 'Works with OpenAI, OpenRouter, Groq, Together, LM Studio and others. Pick a model that accepts images.',
    }
  },

  async plan(r: PlanRequest, creds: Credentials): Promise<ModelReply> {
    if (!r.model) throw new ProviderError('Choose a model id for the OpenAI-compatible provider.', 400)
    const res = await fetch(`${baseUrl(creds)}/chat/completions`, {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify({
        model: r.model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: r.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: r.user },
              ...r.images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    }).catch((e) => {
      throw new ProviderError(`Cannot reach ${baseUrl(creds)}: ${e instanceof Error ? e.message : e}`)
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new ProviderError(json?.error?.message ?? `Provider error ${res.status}`, res.status)
    const text = json?.choices?.[0]?.message?.content
    if (!text) throw new ProviderError('Empty response from the provider')
    return { text: typeof text === 'string' ? text : JSON.stringify(text), model: json.model ?? r.model }
  },
}
