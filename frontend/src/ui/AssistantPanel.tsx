import { useEffect, useRef, useState } from 'react'
import type { SampledFrame } from '../analyze/frames'
import type { SourceVideo } from '../plan/apply'
import { keptDuration, MAX_CAPTION, type Draft, type DraftSegment, type TransitionChoice } from '../plan/draft'
import type { Analysis, Attempt, GenerateResult, Step } from '../plan/generate'

export type Phase = 'empty' | 'analyzing' | 'ready' | 'planning' | 'previewing' | 'kept'

export interface Applied {
  before: import('@elah/editor').Project
  draft: Draft
  rawOutput: string
  attempts: Attempt[]
  request: string
}

export interface HistoryItem {
  request: string
  model: string
  outcome: 'applied' | 'unsupported' | 'invalid' | 'error'
  detail: string
}

const SUGGESTIONS = [
  'Make a 20s reel of the best moments with captions',
  'Cut it to 15 seconds and add the title "Hack Day 2026"',
  'Keep only the intro and the ending, with a fade between them',
]

interface Props {
  phase: Phase
  source: SourceVideo | null
  analysis: Analysis | null
  modelName: string
  modelReady: boolean
  request: string
  setRequest: (s: string) => void
  refining: boolean
  setRefining: (b: boolean) => void
  result: GenerateResult | null
  applied: Applied | null
  error: string | null
  step: Step | null
  elapsed: number
  history: HistoryItem[]
  onPickFile: () => void
  onSubmit: () => void
  onCancel: () => void
  onKeep: () => void
  onDiscard: () => void
  onDraftChange: (d: Draft) => void
  onSeekSegment: (i: number) => void
  onOpenModel: () => void
}

const fmt = (s: number) => `${s.toFixed(1)}s`

export function AssistantPanel(p: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  // Bring a fresh plan into view (matters most on a phone).
  useEffect(() => {
    if (p.applied && p.phase === 'previewing') bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [p.applied?.rawOutput])

  return (
    <div className="assistant">
      <div className="assistant-body" ref={bodyRef}>
        {p.phase === 'empty' && <Welcome onPickFile={p.onPickFile} />}
        {p.phase === 'analyzing' && <AnalyzingCard />}

        {p.phase === 'planning' && <Progress step={p.step} elapsed={p.elapsed} modelName={p.modelName} onCancel={p.onCancel} />}

        {p.error && <div className="notice error">{p.error}</div>}
        {p.phase !== 'planning' && p.result?.kind === 'unsupported' && (
          <div className="notice">
            <strong>That's not something I can do yet.</strong> {p.result.reason}
            <span className="muted"> I can choose which parts to keep, and add captions, a title, and fade/slide/wipe transitions. Your video wasn't changed.</span>
          </div>
        )}
        {p.phase !== 'planning' && p.result?.kind === 'invalid' && (
          <div className="notice error">
            <strong>The model couldn't produce a usable edit, so nothing was changed.</strong>
            <ul>
              {p.result.errors.slice(0, 3).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {p.applied && p.phase !== 'planning' && (
          <PlanEditor
            applied={p.applied}
            kept={p.phase === 'kept'}
            frames={p.analysis?.frames ?? []}
            onChange={p.onDraftChange}
            onKeep={p.onKeep}
            onDiscard={p.onDiscard}
            onSeek={p.onSeekSegment}
          />
        )}

        {p.source && p.analysis && <SourceCard source={p.source} analysis={p.analysis} onReplace={p.onPickFile} disabled={p.phase === 'planning'} />}

        {p.history.length > 0 && (
          <section className="history" aria-label="Recent requests">
            <span className="label">Log</span>
            <ul>
              {p.history.map((h, i) => (
                <li key={i}>
                  <button className="history-item" onClick={() => p.setRequest(h.request)} disabled={p.phase === 'planning'}>
                    <span className={`history-dot ${h.outcome}`} />
                    <span className="history-text">{h.request}</span>
                    <span className="history-meta">
                      {h.model} · {h.detail}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <Composer {...p} />
    </div>
  )
}

function Welcome({ onPickFile }: { onPickFile: () => void }) {
  return (
    <section className="welcome">
      <span className="label">Cutting room</span>
      <h2>
        Edit by <em>describing</em> it.
      </h2>
      <ol>
        <li>Add a video, from 30 seconds to a few minutes</li>
        <li>Say what you want: length, moments, captions</li>
        <li>Review the cut, tweak it, keep it or undo it</li>
      </ol>
      <button className="pill" onClick={onPickFile}>
        Choose a video
      </button>
    </section>
  )
}

function AnalyzingCard() {
  return (
    <section className="card analyzing">
      <span className="spinner" />
      <div>
        <strong>Reading your video</strong>
        <div className="muted">Finding pauses in the speech and picking a frame for each part…</div>
      </div>
    </section>
  )
}

function Progress({ step, elapsed, modelName, onCancel }: { step: Step | null; elapsed: number; modelName: string; onCancel: () => void }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'asking', label: `Asking ${modelName}` },
    ...(step === 'correcting' ? [{ id: 'correcting' as Step, label: 'Fixing a problem in the plan' }] : []),
    { id: 'validating', label: 'Checking the plan against your video' },
  ]
  const at = steps.findIndex((s) => s.id === step)
  return (
    <section className="card progress" aria-live="polite">
      <span className="label">Developing the cut</span>
      <ol>
        <li className="done">Frames and speech segments ready</li>
        {steps.map((s, i) => (
          <li key={s.id} className={i < at ? 'done' : i === at ? 'active' : ''}>
            {s.label}
            {i === at && s.id !== 'validating' && <span className="elapsed">{elapsed}s</span>}
          </li>
        ))}
      </ol>
      <button className="text-btn" onClick={onCancel}>
        Cancel
      </button>
    </section>
  )
}

function nearestFrame(frames: SampledFrame[], t: number) {
  let best: SampledFrame | undefined
  for (const f of frames) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f
  return best
}

function PlanEditor({
  applied,
  kept,
  frames,
  onChange,
  onKeep,
  onDiscard,
  onSeek,
}: {
  applied: Applied
  kept: boolean
  frames: SampledFrame[]
  onChange: (d: Draft) => void
  onKeep: () => void
  onDiscard: () => void
  onSeek: (i: number) => void
}) {
  const d = applied.draft
  const enabledCount = d.segments.filter((s) => s.enabled).length
  const totalMs = applied.attempts.reduce((n, a) => n + a.ms, 0)
  const lastEnabled = d.segments.map((s) => s.enabled).lastIndexOf(true)

  const setSegment = (i: number, patch: Partial<DraftSegment>) =>
    onChange({ ...d, segments: d.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  return (
    <section className="plan" aria-label="Proposed edit">
      <header className="plan-head">
        <div className="plan-head-row">
          <span className={`badge ${kept ? 'kept' : 'preview'}`}>
            <span>{kept ? 'Kept' : 'Preview'}</span>
          </span>
          <div className="plan-head-actions">
            {kept ? (
              <button className="ghost-btn small" onClick={onDiscard}>
                Undo AI edit
              </button>
            ) : (
              <>
                <button className="ghost-btn small danger" onClick={onDiscard}>
                  Discard
                </button>
                <button className="pill small" onClick={onKeep}>
                  Keep
                </button>
              </>
            )}
          </div>
        </div>
        <h2>{d.summary}</h2>
        <div className="plan-meta">
          {fmt(keptDuration(d))} · {enabledCount} {enabledCount === 1 ? 'part' : 'parts'} · {applied.attempts[applied.attempts.length - 1]?.model} ·{' '}
          {(totalMs / 1000).toFixed(1)}s{applied.attempts.length > 1 ? ' · self-corrected' : ''}
        </div>
      </header>

      <label className="title-row">
        <span>Title</span>
        <CommitInput
          value={d.title?.text ?? ''}
          placeholder="Add a title card (optional)"
          onCommit={(text) => onChange({ ...d, title: text ? { text, duration: d.title?.duration ?? 1.5 } : null })}
        />
      </label>

      <ol className="segments">
        {d.segments.map((s, i) => {
          const thumb = nearestFrame(frames, (s.start + s.end) / 2)
          return (
            <li key={`${s.start}-${s.end}`} className={`segment ${s.enabled ? '' : 'off'}`}>
              <button className="segment-thumb" onClick={() => onSeek(i)} disabled={!s.enabled} aria-label={`Play part ${i + 1}`}>
                {thumb && <img src={thumb.dataUrl} alt="" />}
                <span className="segment-time">
                  {fmt(s.start)}–{fmt(s.end)}
                </span>
              </button>
              <div className="segment-body">
                <div className="segment-top">
                  <span className="segment-len">{fmt(s.end - s.start)}</span>
                  <span className="segment-reason">{s.reason}</span>
                  <Switch
                    checked={s.enabled}
                    label={s.enabled ? `Remove part ${i + 1}` : `Include part ${i + 1}`}
                    disabled={s.enabled && enabledCount === 1}
                    onChange={(on) => setSegment(i, { enabled: on })}
                  />
                </div>
                <CommitInput
                  value={s.caption}
                  placeholder="Caption (optional)"
                  disabled={!s.enabled}
                  maxLength={MAX_CAPTION}
                  onCommit={(caption) => setSegment(i, { caption })}
                />
                {s.enabled && i < lastEnabled && (
                  <label className="transition-row">
                    <span>Then</span>
                    <select value={s.transitionAfter} onChange={(e) => setSegment(i, { transitionAfter: e.target.value as TransitionChoice })}>
                      <option value="none">Cut</option>
                      <option value="fade">Fade</option>
                      <option value="slide">Slide</option>
                      <option value="wipe">Wipe</option>
                    </select>
                  </label>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {d.warnings.length > 0 && (
        <ul className="warnings">
          {d.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <details className="raw">
        <summary>Model output</summary>
        <pre>{applied.rawOutput}</pre>
      </details>
    </section>
  )
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (b: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} title={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

/** Text input that applies its value on Enter or blur, so the timeline isn't rebuilt per keystroke. */
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void; placeholder?: string; disabled?: boolean; maxLength?: number }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => v.trim() !== value && onCommit(v.trim())
  return (
    <input
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setV(value)
      }}
    />
  )
}

function SourceCard({ source, analysis, onReplace, disabled }: { source: SourceVideo; analysis: Analysis; onReplace: () => void; disabled: boolean }) {
  return (
    <section className="card source">
      <span className="label">Footage</span>
      <div className="source-head">
        <div>
          <strong>{source.name}</strong>
          <div className="muted">
            {fmt(analysis.duration)} · {analysis.audio.hasAudio ? `${analysis.audio.segments.length} speech parts` : 'no audio'}
          </div>
        </div>
        <button className="text-btn" onClick={onReplace} disabled={disabled}>
          Replace
        </button>
      </div>
      <div className="frames" aria-label="Frames the model sees">
        {analysis.frames.map((f) => (
          <img key={f.time} src={f.dataUrl} alt={`Frame at ${f.time}s`} title={fmt(f.time)} />
        ))}
      </div>
    </section>
  )
}

function Composer(p: Props) {
  const busy = p.phase === 'planning' || p.phase === 'analyzing'
  const hasVideo = Boolean(p.analysis)
  const refining = p.refining && p.phase === 'previewing'
  const canSend = hasVideo && p.request.trim().length > 0 && !busy

  return (
    <div className="composer">
      {!p.applied && hasVideo && !busy && (
        <div className="chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => p.setRequest(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {p.phase === 'previewing' && (
        <div className="composer-mode">
          {refining ? 'Refining this cut' : 'New cut from the full video'}
          <button className="text-btn" onClick={() => p.setRefining(!p.refining)}>
            {refining ? 'Start over instead' : 'Refine instead'}
          </button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          value={p.request}
          rows={2}
          disabled={!hasVideo || busy}
          placeholder={!hasVideo ? 'Add a video first' : refining ? 'e.g. drop the second part, shorter captions' : 'Describe the cut you want…'}
          onChange={(e) => p.setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && canSend) {
              e.preventDefault()
              p.onSubmit()
            }
          }}
        />
        <button className="send" onClick={p.modelReady ? p.onSubmit : p.onOpenModel} disabled={!canSend} aria-label={refining ? 'Refine' : 'Generate cut'}>
          {refining ? 'Refine' : 'Cut'}
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 7h9M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
