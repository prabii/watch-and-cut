import { planSchema, type ValidPlan } from './schema'

export interface ValidateContext {
  duration: number // seconds
  pauses: number[] // seconds
  targetSec?: number // requested reel length, if the user gave one
}

export type ValidationResult =
  | { kind: 'valid'; plan: ValidPlan }
  | { kind: 'unsupported'; reason: string }
  // `soft` errors (length off-target) are retried once, then accepted with a warning.
  | { kind: 'invalid'; errors: string[]; soft: boolean; fallback?: ValidPlan }

const MIN_SEGMENT = 1.0
const SNAP_WINDOW = 0.4
const MAX_CAPTION = 60
const END_TOLERANCE = 0.5

/** Pull the first JSON object out of model text (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('response is not JSON')
  return JSON.parse(candidate.slice(start, end + 1))
}

/** "20s", "20 sec", "half a minute", "1 minute" → seconds. */
export function parseTargetSeconds(request: string): number | undefined {
  const s = request.toLowerCase()
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/)
  if (sec) return parseFloat(sec[1])
  const min = s.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/)
  if (min) return parseFloat(min[1]) * 60
  if (/half a minute/.test(s)) return 30
  return undefined
}

export function validatePlan(rawText: string, ctx: ValidateContext): ValidationResult {
  let raw: unknown
  try {
    raw = extractJson(rawText)
  } catch {
    return { kind: 'invalid', soft: false, errors: ['Output must be a single JSON object matching the schema.'] }
  }

  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return { kind: 'invalid', soft: false, errors }
  }
  const plan = parsed.data
  if (plan.status === 'unsupported') return { kind: 'unsupported', reason: plan.reason }

  const errors: string[] = []
  const warnings: string[] = []
  const { duration } = ctx

  // Collect keep_segments, remembering the model's index so captions/transitions can be remapped.
  const segs: { start: number; end: number; reason: string; modelIndex: number; path: string }[] = []
  plan.operations.forEach((op, i) => {
    if (op.op !== 'keep_segment') return
    const path = `operations[${i}]`
    let { start, end } = op
    if (start < 0 && start > -END_TOLERANCE) start = 0
    if (end > duration && end <= duration + END_TOLERANCE) end = duration
    if (start < 0) errors.push(`${path}.start must be ≥ 0`)
    if (end > duration) errors.push(`${path}.end must be ≤ ${duration.toFixed(1)} (video length)`)
    if (end <= start) errors.push(`${path}.end must be greater than start`)
    segs.push({ start: snap(start, ctx.pauses), end: snap(end, ctx.pauses), reason: op.reason, modelIndex: segs.length, path })
  })

  if (segs.length === 0) errors.push('operations must contain at least one keep_segment')

  for (const s of segs) {
    if (s.end - s.start < MIN_SEGMENT) errors.push(`${s.path} must be at least ${MIN_SEGMENT}s long`)
  }

  const sorted = [...segs].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end - 0.01) {
      errors.push(`${sorted[i].path} overlaps ${sorted[i - 1].path}; kept segments must not overlap`)
    }
  }
  // model index → sorted index
  const remap = new Map(sorted.map((s, i) => [s.modelIndex, i]))

  const captions: ValidPlan['captions'] = []
  const transitions: ValidPlan['transitions'] = []
  let title: ValidPlan['title']

  plan.operations.forEach((op, i) => {
    const path = `operations[${i}]`
    if (op.op === 'add_caption') {
      const idx = remap.get(op.segment)
      if (idx === undefined) {
        errors.push(`${path}.segment ${op.segment} does not refer to a keep_segment (0..${segs.length - 1})`)
        return
      }
      let text = op.text.trim()
      if (text.length > MAX_CAPTION) {
        text = text.slice(0, MAX_CAPTION - 1).trimEnd() + '…'
        warnings.push(`Caption ${idx + 1} was shortened to ${MAX_CAPTION} characters`)
      }
      if (captions.some((c) => c.segment === idx)) {
        warnings.push(`Extra caption for segment ${idx + 1} ignored`)
        return
      }
      captions.push({ segment: idx, text })
    } else if (op.op === 'add_transition') {
      const idx = remap.get(op.after_segment)
      if (idx === undefined || idx >= segs.length - 1) {
        errors.push(`${path}.after_segment must be between 0 and ${segs.length - 2} (a transition needs a next segment)`)
        return
      }
      if (!transitions.some((t) => t.afterSegment === idx)) transitions.push({ afterSegment: idx, kind: op.kind })
    } else if (op.op === 'add_title') {
      const d = Math.min(4, Math.max(0.5, op.duration))
      title = { text: op.text.trim().slice(0, MAX_CAPTION), duration: d }
    }
  })

  const validPlan: ValidPlan = {
    summary: plan.summary,
    segments: sorted.map(({ start, end, reason }) => ({ start, end, reason })),
    captions,
    title,
    transitions,
    warnings,
  }

  if (errors.length) return { kind: 'invalid', soft: false, errors }

  if (ctx.targetSec) {
    const total = validPlan.segments.reduce((n, s) => n + (s.end - s.start), 0)
    const lo = ctx.targetSec * 0.7
    const hi = ctx.targetSec * 1.3
    if (total < lo || total > hi) {
      return {
        kind: 'invalid',
        soft: true,
        errors: [`Kept segments total ${total.toFixed(1)}s; the user asked for about ${ctx.targetSec}s (allowed ${lo.toFixed(0)}–${hi.toFixed(0)}s)`],
        fallback: { ...validPlan, warnings: [...warnings, `Reel is ${total.toFixed(1)}s, requested ~${ctx.targetSec}s`] },
      }
    }
  }

  return { kind: 'valid', plan: validPlan }
}

function snap(t: number, pauses: number[]): number {
  let best = t
  let bestDist = SNAP_WINDOW
  for (const p of pauses) {
    const d = Math.abs(p - t)
    if (d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best
}
