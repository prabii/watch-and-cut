// Headless check of validate → apply → undo against the real elah engine.
import { TimelineEngine } from '@elah/core'
import { validatePlan } from '../src/plan/validate'
import { applyPlan, loadSource, revertTo, TRACK_NAMES } from '../src/plan/apply'

const engine = new TimelineEngine({
  fps: 30,
  initialTracks: [
    { kind: 'elements', name: TRACK_NAMES.title },
    { kind: 'elements', name: TRACK_NAMES.captions },
    { kind: 'video', name: TRACK_NAMES.video },
    { kind: 'audio', name: TRACK_NAMES.audio },
  ],
})
const source = { assetId: 'a1', src: 'blob:x', name: 'talk.mp4', durationSec: 90, hasAudio: true }
loadSource(engine, source)

const ctx = { duration: 90, pauses: [9.9, 41.1, 49.6, 77.3], targetSec: 20 }
const model = '```json\n' + JSON.stringify({
  status: 'ok', summary: '20s reel',
  operations: [
    { op: 'keep_segment', start: 41, end: 49.5, reason: 'tip' },
    { op: 'keep_segment', start: 3.2, end: 9.8, reason: 'hook' },
    { op: 'keep_segment', start: 77.4, end: 81, reason: 'outro' },
    { op: 'add_caption', segment: 1, text: 'Hook' },
    { op: 'add_caption', segment: 0, text: 'Tip #1' },
    { op: 'add_transition', after_segment: 1, kind: 'fade' },
    { op: 'add_title', text: 'Hack Day', duration: 1.5 },
  ],
}) + '\n```'
const v = validatePlan(model, ctx)
if (v.kind !== 'valid') throw new Error('expected valid: ' + JSON.stringify(v))
console.log('segments', v.plan.segments.map((s) => [s.start, s.end]), 'captions', v.plan.captions)

const before = engine.getProject()
const { warnings } = applyPlan(engine, source, v.plan)
const p = engine.getProject()
const name = (id: string) => p.tracks.find((t) => t.id === id)!.name
for (const [tid, clips] of Object.entries(p.clips)) {
  console.log(name(tid), clips.map((c) => `${c.type}@${c.startFrame}+${c.durationFrames} src${c.sourceStartFrame}${c.content ? ` "${c.content}"` : ''}`).join(' | '))
}
console.log('transitions', p.transitions.length, 'warnings', warnings, 'total frames', engine.getTotalFrames())

const ok = revertTo(engine, before)
console.log('one-step revert ok:', ok, 'video clips after revert:', engine.getClipsOnTrack(p.tracks.find(t=>t.kind==='video')!.id).length)

console.log('unsupported →', validatePlan('{"status":"unsupported","reason":"no robots"}', ctx).kind)
console.log('bad →', JSON.stringify(validatePlan('{"status":"ok","operations":[{"op":"keep_segment","start":80,"end":120}]}', ctx)))
console.log('garbage →', JSON.stringify(validatePlan('sure! here is the plan', ctx)))
