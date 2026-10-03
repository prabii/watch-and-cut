import type { TimelineEngine, Project, Track } from '@elah/editor'
import type { ValidPlan } from './schema'

export const TRACK_NAMES = {
  title: 'Title',
  captions: 'Captions',
  video: 'Video',
  audio: 'Audio',
} as const

export interface SourceVideo {
  assetId: string
  src: string
  name: string
  durationSec: number
  hasAudio: boolean
}

const TRANSITION_FRAMES = 12

function findTrack(engine: TimelineEngine, kind: Track['kind'], name: string): Track {
  const tracks = engine.getProject().tracks
  const t = tracks.find((x) => x.kind === kind && x.name === name) ?? tracks.find((x) => x.kind === kind)
  if (!t) throw new Error(`Missing ${name} track`)
  return t
}

function clearTrack(engine: TimelineEngine, trackId: string) {
  for (const c of [...engine.getClipsOnTrack(trackId)]) engine.removeClip(c.id, trackId)
}

/** Put the full, uncut source on the timeline. Call inside a batch. */
function layDownSource(engine: TimelineEngine, source: SourceVideo) {
  const fps = engine.getProject().fps
  const durationFrames = Math.max(1, Math.round(source.durationSec * fps))
  const video = findTrack(engine, 'video', TRACK_NAMES.video)
  const audio = findTrack(engine, 'audio', TRACK_NAMES.audio)
  for (const t of [...engine.getProject().transitions]) engine.removeTransition(t.id)
  for (const t of [video, audio, findTrack(engine, 'elements', TRACK_NAMES.captions), findTrack(engine, 'elements', TRACK_NAMES.title)]) {
    clearTrack(engine, t.id)
  }
  const common = { startFrame: 0, durationFrames, src: source.src, assetId: source.assetId, name: source.name }
  engine.addClip({ type: 'video', trackId: video.id, ...common })
  if (source.hasAudio) engine.addClip({ type: 'audio', trackId: audio.id, ...common })
}

export function loadSource(engine: TimelineEngine, source: SourceVideo) {
  engine.batch(() => layDownSource(engine, source), 'Load video')
}

/**
 * Apply a validated plan as ONE undoable batch. Always starts from the full source,
 * so every plan is expressed in source time and a later plan never depends on an earlier one.
 * Returns the project as it was before, so the caller can roll back exactly this action.
 */
export function applyPlan(engine: TimelineEngine, source: SourceVideo, plan: ValidPlan): { before: Project; warnings: string[] } {
  const before = engine.getProject()
  const warnings = [...plan.warnings]
  const fps = before.fps
  const keep = plan.segments.map((s) => [Math.round(s.start * fps), Math.round(s.end * fps)] as const)

  engine.batch(() => {
    layDownSource(engine, source)
    const video = findTrack(engine, 'video', TRACK_NAMES.video)
    const audio = findTrack(engine, 'audio', TRACK_NAMES.audio)

    for (const track of [video, audio]) {
      // 1. Split the source clip at every kept-segment boundary.
      for (const clip of [...engine.getClipsOnTrack(track.id)]) {
        const cuts = [...new Set(keep.flat())]
          .map((srcFrame) => clip.startFrame + (srcFrame - clip.sourceStartFrame))
          .filter((f) => f > clip.startFrame && f < clip.startFrame + clip.durationFrames)
          .sort((a, b) => a - b)
        let current = clip.id
        for (const f of cuts) {
          const ids = engine.splitClip(current, track.id, f)
          if (ids) current = ids[1]
        }
      }
      // 2. Remove pieces that fall outside every kept segment.
      for (const piece of [...engine.getClipsOnTrack(track.id)]) {
        const mid = piece.sourceStartFrame + piece.durationFrames / 2
        if (!keep.some(([a, b]) => mid >= a && mid < b)) engine.removeClip(piece.id, track.id)
      }
      // 3. Close the gaps (ripple) so the kept pieces play back to back.
      let cursor = 0
      for (const piece of [...engine.getClipsOnTrack(track.id)].sort((a, b) => a.startFrame - b.startFrame)) {
        if (piece.startFrame !== cursor) engine.moveClip(piece.id, track.id, track.id, cursor)
        cursor += piece.durationFrames
      }
    }

    // Timeline position of each kept segment after the ripple.
    const segStart: number[] = []
    let acc = 0
    for (const [a, b] of keep) {
      segStart.push(acc)
      acc += b - a
    }
    const total = acc

    // 4. Transitions between adjacent kept pieces on the video track.
    const pieces = [...engine.getClipsOnTrack(video.id)].sort((a, b) => a.startFrame - b.startFrame)
    for (const t of plan.transitions) {
      const toIdx = pieces.findIndex((p) => Math.abs(p.sourceStartFrame - keep[t.afterSegment + 1][0]) <= 1)
      if (toIdx <= 0) {
        warnings.push(`Transition after segment ${t.afterSegment + 1} skipped`)
        continue
      }
      const added = engine.addTransition({
        fromClipId: pieces[toIdx - 1].id,
        toClipId: pieces[toIdx].id,
        trackId: video.id,
        kind: t.kind,
        durationFrames: TRANSITION_FRAMES,
        easing: 'ease-out',
        direction: 'left',
      })
      if (!added) warnings.push(`Transition after segment ${t.afterSegment + 1} could not be added`)
    }

    // 5. Captions, aligned to their segment.
    const captions = findTrack(engine, 'elements', TRACK_NAMES.captions)
    for (const c of plan.captions) {
      const [a, b] = keep[c.segment]
      const clip = engine.addClip({
        type: 'text',
        trackId: captions.id,
        name: `Caption ${c.segment + 1}`,
        startFrame: segStart[c.segment],
        durationFrames: Math.max(1, b - a),
        transform: { x: 0.5, y: 0.8, scale: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
        text: { content: c.text, fontSize: 64, color: '#ffffff', fontWeight: 'bold', textAlign: 'center' },
      })
      engine.updateClip(clip.id, captions.id, {
        backgroundColor: '#000000',
        backgroundOpacity: 0.55,
        padding: 18,
        borderRadius: 14,
        textAnimation: { in: 'fade', out: 'fade', durationFrames: 6 },
      })
    }

    // 6. Optional title card over the opening.
    if (plan.title) {
      const title = findTrack(engine, 'elements', TRACK_NAMES.title)
      const clip = engine.addClip({
        type: 'text',
        trackId: title.id,
        name: 'Title',
        startFrame: 0,
        durationFrames: Math.max(1, Math.min(total, Math.round(plan.title.duration * fps))),
        transform: { x: 0.5, y: 0.2, scale: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
        text: { content: plan.title.text, fontSize: 96, color: '#ffffff', fontWeight: 'bold', textAlign: 'center' },
      })
      engine.updateClip(clip.id, title.id, { textAnimation: { in: 'slide-up', out: 'fade', durationFrames: 10 } })
    }
  }, `AI: ${plan.summary}`)

  return { before, warnings }
}

/** Roll back to `before`. Normally exactly one undo (the AI batch); also unwinds manual edits made on top of it. */
export function revertTo(engine: TimelineEngine, before: Project): boolean {
  for (let i = 0; i < 100 && engine.getProject() !== before; i++) {
    if (!engine.undo()) break
  }
  return engine.getProject() === before
}
