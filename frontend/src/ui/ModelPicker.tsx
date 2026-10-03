import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { listModels, type ModelInfo, type ProviderInfo } from '../ai/client'
import { modelLabel, PROVIDER_BLURB, readiness, targetFor, type ModelSettings } from '../ai/settings'

interface Props {
  providers: ProviderInfo[]
  settings: ModelSettings
  onChange: (s: ModelSettings) => void
  warm: 'idle' | 'loading' | 'ready' | 'failed'
  open: boolean
  setOpen: (open: boolean) => void
  disabled?: boolean
}

const STATUS_TEXT = {
  ready: 'Ready',
  'needs-key': 'Add API key',
  'needs-model': 'Choose a model',
  unavailable: 'Not running',
  loading: 'Loading…',
} as const

export function ModelPicker({ providers, settings, onChange, warm, open, setOpen, disabled }: Props) {
  const current = providers.find((p) => p.id === settings.provider)
  const state = readiness(settings, current)
  const dot = state === 'ready' ? (current?.kind === 'local' && warm === 'loading' ? 'busy' : 'ok') : state === 'loading' ? 'idle' : 'warn'

  return (
    <>
      <button className="model-chip" onClick={() => setOpen(true)} disabled={disabled} aria-haspopup="dialog">
        <span className={`dot ${dot}`} />
        <span className="model-chip-name">{current ? modelLabel(settings, current) : 'Loading models…'}</span>
        {state !== 'ready' && state !== 'loading' && <span className="model-chip-hint">{STATUS_TEXT[state]}</span>}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {/* Rendered at the page root so no panel or overlay can stack above it. */}
      {open && createPortal(<ModelSheet providers={providers} settings={settings} onChange={onChange} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function ModelSheet({ providers, settings, onChange, onClose }: { providers: ProviderInfo[]; settings: ModelSettings; onChange: (s: ModelSettings) => void; onClose: () => void }) {
  const p = providers.find((x) => x.id === settings.provider)
  const target = targetFor(settings, p)
  const [live, setLive] = useState<ModelInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)

  // Fetch the provider's real model list whenever the provider, key or endpoint changes.
  useEffect(() => {
    if (!p || !p.available) return
    if (p.needsKey && !p.serverKey && !settings.keys[p.id] && !(p.customBaseUrl && settings.baseUrl)) {
      setLive(null)
      return
    }
    let cancelled = false
    setListError(null)
    const t = setTimeout(() => {
      listModels(p.id, {
        apiKey: settings.keys[p.id],
        baseUrl: p.customBaseUrl ? settings.baseUrl : undefined,
        workspaceId: p.id === 'anthropic' ? settings.workspaceId : undefined,
      })
        .then((m) => !cancelled && setLive(m))
        .catch((e) => !cancelled && (setLive(null), setListError(e instanceof Error ? e.message : String(e))))
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [p?.id, p?.available, settings.keys[settings.provider], settings.baseUrl, settings.workspaceId])

  const options = useMemo(() => {
    const base = live && live.length ? live : (p?.models ?? [])
    return target.model && !base.some((m) => m.id === target.model) ? [{ id: target.model, label: target.model }, ...base] : base
  }, [live, p, target.model])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (patch: Partial<ModelSettings>) => onChange({ ...settings, ...patch })
  const setModel = (model: string) => set({ models: { ...settings.models, [settings.provider]: model } })

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="model-sheet-title">
        <div className="sheet-head">
          <h2 id="model-sheet-title">Model</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="provider-grid" role="radiogroup" aria-label="Provider">
          {providers.map((x) => {
            const r = readiness(settings, x)
            return (
              <button
                key={x.id}
                role="radio"
                aria-checked={x.id === settings.provider}
                className={`provider-card ${x.id === settings.provider ? 'on' : ''}`}
                onClick={() => {
                  setCustom(false)
                  set({ provider: x.id })
                }}
              >
                <span className="provider-name">{x.label}</span>
                <span className="provider-blurb">{PROVIDER_BLURB[x.id] ?? ''}</span>
                <span className={`provider-state ${r}`}>{STATUS_TEXT[r]}</span>
              </button>
            )
          })}
        </div>

        {p && (
          <div className="sheet-fields">
            {p.note && <p className="sheet-note">{p.note}</p>}

            {p.customBaseUrl && (
              <label className="field">
                <span>Endpoint</span>
                <input
                  value={settings.baseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => set({ baseUrl: e.target.value.trim() })}
                  spellCheck={false}
                />
              </label>
            )}

            {p.needsKey && (
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={settings.keys[p.id] ?? ''}
                  placeholder={p.serverKey ? 'Using the key set up for this app' : 'Paste your key'}
                  onChange={(e) => set({ keys: { ...settings.keys, [p.id]: e.target.value.trim() } })}
                  spellCheck={false}
                />
                <small>{p.serverKey ? 'Optional. Add your own to use your account.' : 'Stays in this browser and is only sent with your requests.'}</small>
              </label>
            )}

            {p.id === 'anthropic' && (
              <label className="field">
                <span>Workspace ID</span>
                <input
                  value={settings.workspaceId}
                  placeholder="wrkspc_… (only if your key asks for one)"
                  onChange={(e) => set({ workspaceId: e.target.value.trim() })}
                  spellCheck={false}
                />
                <small>Find it in the Claude Console under Settings → Workspaces.</small>
              </label>
            )}

            <label className="field">
              <span>Model</span>
              {custom || options.length === 0 ? (
                <input
                  value={target.model}
                  placeholder="Model ID, e.g. one that accepts images"
                  onChange={(e) => setModel(e.target.value.trim())}
                  spellCheck={false}
                />
              ) : (
                <select value={target.model} onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : setModel(e.target.value))}>
                  {options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.detail ? ` · ${m.detail}` : m.label !== m.id ? ` · ${m.id}` : ''}
                    </option>
                  ))}
                  <option value="__custom">Other model ID…</option>
                </select>
              )}
              {listError && <small className="field-error">Couldn't load models: {listError}</small>}
            </label>
          </div>
        )}

        <div className="sheet-foot">
          <button className="pill" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
