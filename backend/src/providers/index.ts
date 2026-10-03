import Anthropic from '@anthropic-ai/sdk'
import { anthropicProvider, claudeClient, discoverWorkspace, needsWorkspace, WORKSPACE_HELP } from './anthropic'
import { geminiProvider, listGeminiModels } from './gemini'
import { listOllamaModels, ollamaProvider } from './ollama'
import { listOpenAIModels, openaiProvider } from './openai'
import { ProviderError, type Credentials, type ModelInfo, type Provider } from './types'

export const PROVIDERS: Record<string, Provider> = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  ollama: ollamaProvider,
}

export function getProvider(id: string): Provider {
  const p = PROVIDERS[id]
  if (!p) throw new ProviderError(`Unknown provider "${id}"`, 400)
  return p
}

/** Live model list from the provider's own API (uses the browser's key when given). */
export async function listModels(id: string, creds: Credentials): Promise<ModelInfo[]> {
  switch (id) {
    case 'gemini':
      return listGeminiModels(creds)
    case 'openai':
      return listOpenAIModels(creds)
    case 'ollama':
      return listOllamaModels()
    case 'anthropic': {
      if (!claudeClient(creds)) return (await anthropicProvider.info()).models
      const list = async (c: Credentials) => {
        const out: ModelInfo[] = []
        for await (const m of claudeClient(c, 15_000)!.models.list()) out.push({ id: m.id, label: m.display_name })
        return out
      }
      try {
        try {
          return await list(creds)
        } catch (e) {
          if (!needsWorkspace(e)) throw e
          const ws = await discoverWorkspace(creds)
          if (!ws) throw new ProviderError(WORKSPACE_HELP, 400)
          return await list({ ...creds, workspaceId: ws })
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e
        if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('Claude rejected the API key.', 401)
        throw e
      }
    }
    default:
      throw new ProviderError(`Unknown provider "${id}"`, 400)
  }
}
