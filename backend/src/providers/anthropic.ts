import Anthropic from '@anthropic-ai/sdk'
import { PLAN_JSON_SCHEMA } from './planSchema'
import { ProviderError, type Credentials, type ModelReply, type PlanRequest, type Provider } from './types'

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

// Models that take `output_config.effort` and the server-side refusal fallback.
// Unknown/custom ids get neither, so they can't 400 on an unsupported field.
const EFFORT_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1'])

export const WORKSPACE_HELP =
  'Your Claude key needs a workspace ID. In the Claude Console open Settings → Workspaces, copy the ID (it starts with wrkspc_) and paste it in model settings.'

// Workspaces found automatically for keys that aren't scoped to one (memory only, never persisted).
const discovered = new Map<string, string>()

/** Client for the user's key (or the server's). Keys not scoped to a workspace need the workspace header. */
export function claudeClient(creds: Credentials, timeout = 120_000) {
  const apiKey = creds.apiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const workspaceId = creds.workspaceId || process.env.ANTHROPIC_WORKSPACE_ID || discovered.get(apiKey)
  return new Anthropic({ apiKey, timeout, ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}) })
}

export const needsWorkspace = (e: unknown) => e instanceof Anthropic.BadRequestError && /workspace/i.test(e.message)

/**
 * Best effort: if the key may list the organization's workspaces, use the first active one.
 * Most keys can't (that needs an admin credential); then the user supplies the ID.
 */
export async function discoverWorkspace(creds: Credentials): Promise<string | null> {
  const apiKey = creds.apiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  try {
    const client = new Anthropic({ apiKey, timeout: 10_000 })
    for await (const w of client.beta.organization.workspaces.list()) {
      if (!w.archived_at) {
        discovered.set(apiKey, w.id)
        return w.id
      }
    }
  } catch {
    // not permitted for this key
  }
  return null
}

async function createPlan(client: Anthropic, r: PlanRequest): Promise<ModelReply> {
  const tuned = EFFORT_MODELS.has(r.model)
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...r.images.map(
      (data): Anthropic.Beta.BetaImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
      }),
    ),
    { type: 'text', text: r.user },
  ]

  const response = await client.beta.messages.create({
    model: r.model,
    max_tokens: 16000,
    system: r.system,
    messages: [{ role: 'user', content }],
    // Structured output: the reply is guaranteed to be JSON matching the plan schema.
    output_config: {
      format: { type: 'json_schema', schema: PLAN_JSON_SCHEMA },
      // An edit plan is a short, bounded task; medium keeps latency interactive.
      ...(tuned ? { effort: 'medium' as const } : {}),
    },
    // If a request is declined by a safety classifier, retry on a fallback model in the same call.
    ...(tuned ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  })

  if (response.stop_reason === 'refusal') {
    throw new ProviderError(`Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}.`, 422)
  }
  if (response.stop_reason === 'max_tokens') throw new ProviderError('Claude ran out of output tokens before finishing the plan.')
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  if (!text) throw new ProviderError('Empty response from Claude')
  return { text, model: response.model }
}

export const anthropicProvider: Provider = {
  async info() {
    return {
      id: 'anthropic',
      label: 'Claude (Anthropic)',
      kind: 'cloud',
      serverKey: Boolean(process.env.ANTHROPIC_API_KEY),
      needsKey: true,
      customBaseUrl: false,
      defaultModel: 'claude-opus-5-5',
      models: MODELS,
      available: true,
    }
  },

  async plan(r: PlanRequest, creds: Credentials): Promise<ModelReply> {
    const client = claudeClient(creds)
    if (!client) throw new ProviderError('Add a Claude API key in model settings to use Claude.', 400)
    try {
      try {
        return await createPlan(client, r)
      } catch (e) {
        if (!needsWorkspace(e)) throw e
        const ws = await discoverWorkspace(creds)
        if (!ws) throw new ProviderError(WORKSPACE_HELP, 400)
        return await createPlan(claudeClient({ ...creds, workspaceId: ws })!, r)
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      if (needsWorkspace(e)) throw new ProviderError(WORKSPACE_HELP, 400)
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('Claude rejected the API key.', 401)
      if (e instanceof Anthropic.PermissionDeniedError) throw new ProviderError("This Claude key can't use that workspace or model. Check the workspace ID in model settings.", 403)
      if (e instanceof Anthropic.NotFoundError) throw new ProviderError(`Claude model "${r.model}" was not found.`, 400)
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError('Claude rate limit reached. Try again in a moment.', 429)
      if (e instanceof Anthropic.BadRequestError) throw new ProviderError(`Claude rejected the request: ${e.message}`, 400)
      if (e instanceof Anthropic.APIError) throw new ProviderError(`Claude API error ${e.status ?? ''}: ${e.message}`)
      throw e
    }
  },
}
