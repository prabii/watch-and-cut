import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EditorProvider,
  Preview,
  Timeline,
  createDefaultDemuxerFactory,
  useTimelineEngine,
  useMediaLibrary,
  usePlaybackStore,
  useTracksStore,
  framesToTimecode,
  lazyExportVideo,
  type InitialTrackConfig,
} from '@elah/editor'
import { sampleFrames } from './analyze/frames'
import { analyzeAudio, frameTimesForSegments } from './analyze/silence'
import { getProviders, warmup, type ProviderInfo } from './ai/client'
import { loadSettings, modelLabel, readiness, saveSettings, targetFor, type ModelSettings } from './ai/settings'
import { applyPlan, loadSource, revertTo, TRACK_NAMES, type SourceVideo } from './plan/apply'
import { draftFromPlan, keptDuration, planFromDraft, timelineStart, type Draft } from './plan/draft'
import { generatePlan, type Analysis, type GenerateResult, type Step } from './plan/generate'
import type { ValidPlan } from './plan/schema'
import { AssistantPanel, type Applied, type HistoryItem, type Phase } from './ui/AssistantPanel'
import { ModelPicker } from './ui/ModelPicker'

const FPS = 30
// Created once at module scope: it owns decoder state.
const demuxerFactory = createDefaultDemuxerFactory()

// Lower index renders on top: title over captions over video.
const TRACKS: InitialTrackConfig[] = [
  { kind: 'elements', name: TRACK_NAMES.title },
  { kind: 'elements', name: TRACK_NAMES.captions },
  { kind: 'video', name: TRACK_NAMES.video, protected: true },
  { kind: 'audio', name: TRACK_NAMES.audio },
]

const STAGES = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
} as const
type StageKey = keyof typeof STAGES

export default function App() {
  return (
    <EditorProvider fps={FPS} stage={STAGES['9:16']} initialTracks={TRACKS} maxHistorySize={100}>
      <Studio />
    </EditorProvider>
  )
}

/** A (possibly user-edited) plan in the model's own JSON shape, for refinement requests. */
function planToModelJson(plan: ValidPlan): string {
  return JSON.stringify({
    status: 'ok',
    summary: plan.summary,
    operations: [
      ...(plan.title ? [{ op: 'add_title', text: plan.title.text, duration: plan.title.duration }] : []),
      ...plan.segments.map((s) => ({ op: 'keep_segment', start: s.start, end: s.end, reason: s.reason })),
      ...plan.captions.map((c) => ({ op: 'add_caption', segment: c.segment, text: c.text })),
      ...plan.transitions.map((t) => ({ op: 'add_transition', after_segment: t.afterSegment, kind: t.kind })),
    ],
  })
}

function initialSettings(): ModelSettings {
  const s = loadSettings()
  return new URLSearchParams(location.search).get('mode') === 'offline' ? { ...s, provider: 'ollama' } : s
}

function Studio() {
  const engine = useTimelineEngine()
  const { importFiles } = useMediaLibrary()
  const fileInput = useRef<HTMLInputElement>(null)

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [settings, setSettings] = useState<ModelSettings>(initialSettings)
  const [modelOpen, setModelOpen] = useState(false)
  const [warm, setWarm] = useState<{ model: string; state: 'idle' | 'loading' | 'ready' | 'failed' }>({ model: '', state: 'idle' })

  const [phase, setPhase] = useState<Phase>('empty')
  const [stage, setStageKey] = useState<StageKey>('9:16')
  const [source, setSource] = useState<SourceVideo | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [request, setRequest] = useState('')
  const [refining, setRefining] = useState(true)
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [exportPct, setExportPct] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const provider = providers.find((p) => p.id === settings.provider)
  const target = targetFor(settings, provider)
  const ready = readiness(settings, provider) === 'ready'
  const label = modelLabel(settings, provider)

  const updateSettings = (s: ModelSettings) => {
    setSettings(s)
    saveSettings(s)
  }

  // Provider status (keys configured, Ollama running and its installed models).
  useEffect(() => {
    const load = () => getProviders().then(setProviders).catch(() => {})
    load()
    const id = setInterval(load, 20000)
    return () => clearInterval(id)
  }, [])

  // Local models: load into memory as soon as one is selected, so the first cut isn't slow.
  useEffect(() => {
    if (provider?.kind !== 'local' || !ready || !target.model || warm.model === target.model) return
    setWarm({ model: target.model, state: 'loading' })
    warmup(target.model)
      .then(() => setWarm({ model: target.model, state: 'ready' }))
      .catch(() => setWarm({ model: target.model, state: 'failed' }))
  }, [provider?.kind, ready, target.model, warm.model])

  useEffect(() => {
    if (phase !== 'planning') return
    const t0 = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250)
    return () => clearInterval(id)
  }, [phase])

  async function onFile(file: File) {
    if (!file.type.startsWith('video/')) {
      setError('That file is not a video.')
      return
    }
    setError(null)
    setResult(null)
    setApplied(null)
    setPhase('analyzing')
    try {
      const { imported } = await importFiles([file])
      const asset = imported[0]
      if (!asset || asset.kind !== 'video') throw new Error("Couldn't open that video.")
      const duration = asset.durationSec > 0 ? asset.durationSec : (await sampleFrames(asset.src, 1)).duration
      const audio = await analyzeAudio(asset.src, duration)
      // One frame per speech segment, so the model judges each segment by its own picture.
      // Too few segments (silent or continuous audio): fall back to evenly spaced frames.
      const picks = audio.segments.length >= 4 ? frameTimesForSegments(audio.segments, 10) : null
      const sample = await sampleFrames(asset.src, picks ? picks.map((p) => p.time) : 10)
      if (picks) sample.frames.forEach((f, i) => (f.segment = picks[i].segment))
      const src: SourceVideo = { assetId: asset.id, src: asset.src, name: asset.name, durationSec: duration, hasAudio: audio.hasAudio }
      loadSource(engine, src)
      setSource(src)
      setAnalysis({ duration, frames: sample.frames, audio })
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase(source ? 'ready' : 'empty')
    }
  }

  function applyDraft(draft: Draft, base: Applied | null, extra: Omit<Applied, 'before' | 'draft'>) {
    if (!source) return
    if (base) revertTo(engine, base.before)
    const { before, warnings } = applyPlan(engine, source, planFromDraft(draft))
    setApplied({ ...extra, before, draft: { ...draft, warnings: [...draft.warnings, ...warnings] } })
  }

  async function run() {
    if (!analysis || !source || !request.trim()) return
    if (!ready) {
      setModelOpen(true)
      return
    }
    const prev = applied
    const prevPhase = phase
    const isRefine = prevPhase === 'previewing' && refining && prev !== null
    const baseRequest = isRefine ? prev.request : request.trim()
    const refine = isRefine ? { output: planToModelJson(planFromDraft(prev.draft)), feedback: request.trim() } : undefined

    setError(null)
    setResult(null)
    setStep(null)
    usePlaybackStore.getState().pause()
    setPhase('planning')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const historyEntry = (outcome: HistoryItem['outcome'], detail: string) =>
      setHistory((h) => [{ request: request.trim(), model: label, outcome, detail }, ...h].slice(0, 6))

    try {
      const r = await generatePlan({
        target,
        maxFrames: provider?.kind === 'local' ? 6 : 10,
        request: baseRequest,
        analysis,
        refine,
        signal: ctrl.signal,
        onStep: setStep,
      })
      setResult(r)
      if (r.kind === 'valid') {
        // Only now touch the timeline: a failed request leaves the current cut as it was.
        const draft = draftFromPlan(r.plan)
        applyDraft(draft, prevPhase === 'previewing' ? prev : null, { rawOutput: r.rawOutput, attempts: r.attempts, request: baseRequest })
        setPhase('previewing')
        setRequest('')
        setRefining(true)
        historyEntry('applied', `${keptDuration(draft).toFixed(1)}s cut`)
        const pb = usePlaybackStore.getState()
        pb.setCurrentFrame(0)
        pb.play()
      } else {
        historyEntry(r.kind, r.kind === 'unsupported' ? 'not supported' : 'no usable plan')
        setPhase(prevPhase)
      }
    } catch (e) {
      setError(ctrl.signal.aborted ? 'Cancelled.' : e instanceof Error ? e.message : String(e))
      if (!ctrl.signal.aborted) historyEntry('error', 'failed')
      setPhase(prevPhase)
    } finally {
      abortRef.current = null
      setStep(null)
    }
  }

  function onDraftChange(d: Draft) {
    if (!applied) return
    applyDraft({ ...d, warnings: [] }, applied, { rawOutput: applied.rawOutput, attempts: applied.attempts, request: applied.request })
  }

  function onSeekSegment(i: number) {
    if (!applied) return
    const t = timelineStart(applied.draft, i)
    if (t === null) return
    const pb = usePlaybackStore.getState()
    pb.setCurrentFrame(Math.round(t * FPS))
    pb.play()
  }

  function keep() {
    setPhase('kept')
    setResult(null)
  }

  function discard() {
    if (!applied) return
    usePlaybackStore.getState().pause()
    revertTo(engine, applied.before)
    setApplied(null)
    setResult(null)
    usePlaybackStore.getState().setCurrentFrame(0)
    setPhase('ready')
  }

  function switchStage(key: StageKey) {
    setStageKey(key)
    engine.setStage(STAGES[key].width, STAGES[key].height)
  }

  async function exportMp4() {
    usePlaybackStore.getState().pause()
    setExportPct(0)
    try {
      const blob = await lazyExportVideo(engine.getProject(), {
        outputHeight: 720,
        onProgress: ({ frame, totalFrames }) => setExportPct(Math.round((frame / Math.max(1, totalFrames)) * 100)),
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${source?.name.replace(/\.[^.]+$/, '') ?? 'video'}-cut.mp4`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExportPct(null)
    }
  }

  const pickFile = useCallback(() => fileInput.current?.click(), [])
  const busy = phase === 'planning' || phase === 'analyzing'

  return (
    <div className="elah-root app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Watch-and-Cut home">
          <BrandMark />
          <span>Watch-and-Cut</span>
        </a>
        <div className="slate-line" aria-live="polite">
          <span className={`tally ${phase === 'planning' || phase === 'analyzing' ? 'live' : ''}`} />
          {source && analysis ? (
            <>
              Reel 01 · <b>{source.name}</b> · {framesToTimecode(Math.round(analysis.duration * FPS), FPS)}
            </>
          ) : (
            'No footage loaded'
          )}
        </div>
        <div className="topbar-right">
          <ModelPicker
            providers={providers}
            settings={settings}
            onChange={updateSettings}
            warm={warm.model === target.model ? warm.state : 'idle'}
            open={modelOpen}
            setOpen={setModelOpen}
            disabled={phase === 'planning'}
          />
          <div className="seg" role="group" aria-label="Aspect ratio">
            {(Object.keys(STAGES) as StageKey[]).map((k) => (
              <button key={k} className={stage === k ? 'on' : ''} onClick={() => switchStage(k)}>
                {k}
              </button>
            ))}
          </div>
          <button className="pill small" onClick={exportMp4} disabled={!source || busy || exportPct !== null}>
            {exportPct !== null ? `${exportPct}%` : 'Export'}
          </button>
        </div>
      </header>

      <main className="workspace">
        <section
          className={`stage-col ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            if (busy) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const f = e.dataTransfer.files[0]
            if (f && !busy) void onFile(f)
          }}
        >
          <div className="stage-wrap">
            <Preview demuxerFactory={demuxerFactory} enableAudio style={{ position: 'absolute', inset: 0 }} />
            <span className="crop tl" />
            <span className="crop tr" />
            <span className="crop bl" />
            <span className="crop br" />
            {phase === 'empty' && (
              <button className="dropzone" onClick={pickFile}>
                <span className="dropzone-title">Drop the footage.</span>
                <span className="dropzone-hint">
                  or <em>click</em> to choose a video · mp4 · mov · webm
                </span>
              </button>
            )}
            {dragging && <div className="drop-overlay">Let it go.</div>}
          </div>
          <Transport />
        </section>

        <aside className="panel">
          <AssistantPanel
            phase={phase}
            source={source}
            analysis={analysis}
            modelName={label}
            modelReady={ready}
            request={request}
            setRequest={setRequest}
            refining={refining}
            setRefining={setRefining}
            result={result}
            applied={applied}
            error={error}
            step={step}
            elapsed={elapsed}
            history={history}
            onPickFile={pickFile}
            onSubmit={run}
            onCancel={() => abortRef.current?.abort()}
            onKeep={keep}
            onDiscard={discard}
            onDraftChange={onDraftChange}
            onSeekSegment={onSeekSegment}
            onOpenModel={() => setModelOpen(true)}
          />
        </aside>
      </main>

      <Timeline fps={FPS} compactSidebar style={{ height: 'var(--timeline-h)', flexShrink: 0 }} />

      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function Transport() {
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const currentFrame = usePlaybackStore((s) => s.currentFrame)
  const toggle = usePlaybackStore((s) => s.togglePlayPause)
  const totalFrames = useTracksStore((s) => s.totalFrames)
  return (
    <div className="transport">
      <button className="play" onClick={toggle} disabled={totalFrames === 0} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor" />
            <rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M4 2.5v9l7.5-4.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <span className="timecode">
        {framesToTimecode(currentFrame, FPS)} <span>/ {framesToTimecode(Math.max(totalFrames, 1), FPS)}</span>
      </span>
    </div>
  )
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 31.5 48.5" aria-hidden="true">
      <defs>
        <linearGradient id="wc-mark" x1="8" y1="0" x2="34.1" y2="28.9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9e9e9e" />
          <stop offset=".34" stopColor="#a3a3a3" />
          <stop offset=".40" stopColor="#3a3a3a" />
          <stop offset=".55" stopColor="#414141" />
          <stop offset=".68" stopColor="#8e8e8e" />
          <stop offset="1" stopColor="#cccccc" />
        </linearGradient>
      </defs>
      <path d="M21.5 0 L21.5 19.5 L31.5 19.5 L31.5 29 L10 48.5 L10 28.5 L0.5 28.5 L0.5 18.5 Z" fill="url(#wc-mark)" />
      <rect x="0.5" y="18.5" width="9" height="10" fill="#fdfdfd" />
      <rect x="22" y="19.5" width="9.5" height="9.5" fill="#fdfdfd" />
    </svg>
  )
}
