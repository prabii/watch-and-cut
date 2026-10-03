export interface ModelInfo {
  id: string
  label: string
  detail?: string
}

export interface ProviderInfo {
  id: string
  label: string
  kind: 'cloud' | 'local'
  serverKey: boolean
  needsKey: boolean
  customBaseUrl: boolean
  defaultModel: string
  models: ModelInfo[]
  available: boolean
  note?: string
}

/** Which model to call, plus the user's own key/base URL if they brought one. */
export interface ModelTarget {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  workspaceId?: string
}

export interface ModelReply {
  text: string
  model: string
  ms: number
}

type Creds = Pick<ModelTarget, 'apiKey' | 'baseUrl' | 'workspaceId'>

function credentialHeaders(t: Creds): Record<string, string> {
  const h: Record<string, string> = {}
  if (t.apiKey) h['x-provider-key'] = t.apiKey
  if (t.baseUrl) h['x-provider-base-url'] = t.baseUrl
  if (t.workspaceId) h['x-provider-workspace'] = t.workspaceId
  return h
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({ error: `Server error ${res.status}` }))
  if (!res.ok) throw new Error(body.error ?? `Server error ${res.status}`)
  return body
}

export async function getProviders(): Promise<ProviderInfo[]> {
  return (await json<{ providers: ProviderInfo[] }>(await fetch('/api/providers'))).providers
}

export async function listModels(provider: string, creds: Creds): Promise<ModelInfo[]> {
  const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, { headers: credentialHeaders(creds) })
  return (await json<{ models: ModelInfo[] }>(res)).models
}

/** Load a local (Ollama) model into memory ahead of the first request. */
export async function warmup(model: string): Promise<void> {
  await json(
    await fetch('/api/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
  )
}

export async function requestPlan(
  target: ModelTarget,
  system: string,
  user: string,
  images: string[],
  signal?: AbortSignal,
): Promise<ModelReply> {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credentialHeaders(target) },
    body: JSON.stringify({ provider: target.provider, model: target.model, system, user, images }),
    signal,
  })
  return json<ModelReply>(res)
}
