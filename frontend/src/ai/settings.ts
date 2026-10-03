// The user's model choice and their own API keys. Kept in this browser only
// (localStorage) and sent to the local backend per request; never shared elsewhere.
import type { ModelTarget, ProviderInfo } from './client'

export interface ModelSettings {
  provider: string
  models: Record<string, string> // chosen model per provider
  keys: Record<string, string> // user's own key per provider
  baseUrl: string // OpenAI-compatible endpoint
  workspaceId: string // Claude keys that aren't scoped to a workspace
}

const STORAGE_KEY = 'watch-and-cut.model-settings.v1'

export const DEFAULT_SETTINGS: ModelSettings = { provider: 'gemini', models: {}, keys: {}, baseUrl: '', workspaceId: '' }

export function loadSettings(): ModelSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    // storage blocked or corrupt: fall back to defaults
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: ModelSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // storage blocked: settings last for this session only
  }
}

export function targetFor(s: ModelSettings, p: ProviderInfo | undefined): ModelTarget {
  return {
    provider: s.provider,
    model: s.models[s.provider] || p?.defaultModel || '',
    apiKey: s.keys[s.provider] || undefined,
    baseUrl: p?.customBaseUrl ? s.baseUrl || undefined : undefined,
    workspaceId: s.provider === 'anthropic' ? s.workspaceId || undefined : undefined,
  }
}

export type Readiness = 'ready' | 'needs-key' | 'needs-model' | 'unavailable' | 'loading'

export function readiness(s: ModelSettings, p: ProviderInfo | undefined): Readiness {
  if (!p) return 'loading'
  if (!p.available) return 'unavailable'
  if (p.needsKey && !p.serverKey && !s.keys[p.id]) return 'needs-key'
  if (!targetFor(s, p).model) return 'needs-model'
  return 'ready'
}

export function modelLabel(s: ModelSettings, p: ProviderInfo | undefined): string {
  const id = targetFor(s, p).model
  return p?.models.find((m) => m.id === id)?.label ?? (id || 'Choose a model')
}

export const PROVIDER_BLURB: Record<string, string> = {
  gemini: 'Gemma 4 and Gemini through Google AI Studio',
  anthropic: 'Claude Opus, Sonnet and Haiku',
  openai: 'OpenAI, OpenRouter, Groq, LM Studio…',
  ollama: 'Runs on this computer, no internet',
}
