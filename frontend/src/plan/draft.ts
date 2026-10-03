// The editable form of an AI plan. The user can switch segments off, rewrite captions,
// change transitions and the title; each change is re-applied as the same single AI edit.
import { TRANSITION_KINDS, type ValidPlan } from './schema'

export type TransitionChoice = 'none' | (typeof TRANSITION_KINDS)[number]

export interface DraftSegment {
  start: number
  end: number
  reason: string
  enabled: boolean
  caption: string
  transitionAfter: TransitionChoice
}

export interface Draft {
  summary: string
  segments: DraftSegment[]
  title: { text: string; duration: number } | null
  warnings: string[]
}

export const MAX_CAPTION = 60

export function draftFromPlan(plan: ValidPlan): Draft {
  return {
    summary: plan.summary,
    segments: plan.segments.map((s, i) => ({
      ...s,
      enabled: true,
      caption: plan.captions.find((c) => c.segment === i)?.text ?? '',
      transitionAfter: plan.transitions.find((t) => t.afterSegment === i)?.kind ?? 'none',
    })),
    title: plan.title ?? null,
    warnings: plan.warnings,
  }
}

/** Back to the shape the applier understands: only enabled segments, indexes renumbered. */
export function planFromDraft(d: Draft): ValidPlan {
  const kept = d.segments.filter((s) => s.enabled)
  return {
    summary: d.summary,
    segments: kept.map(({ start, end, reason }) => ({ start, end, reason })),
    captions: kept
      .map((s, i) => ({ segment: i, text: s.caption.trim().slice(0, MAX_CAPTION) }))
      .filter((c) => c.text.length > 0),
    transitions: kept
      .slice(0, -1)
      .map((s, i) => ({ afterSegment: i, kind: s.transitionAfter }))
      .filter((t): t is { afterSegment: number; kind: (typeof TRANSITION_KINDS)[number] } => t.kind !== 'none'),
    title: d.title && d.title.text.trim() ? { text: d.title.text.trim().slice(0, MAX_CAPTION), duration: d.title.duration } : undefined,
    warnings: [],
  }
}

export const keptDuration = (d: Draft) => d.segments.reduce((n, s) => n + (s.enabled ? s.end - s.start : 0), 0)

/** Where segment `i` starts on the edited timeline (seconds), or null if it's switched off. */
export function timelineStart(d: Draft, i: number): number | null {
  if (!d.segments[i]?.enabled) return null
  return d.segments.slice(0, i).reduce((n, s) => n + (s.enabled ? s.end - s.start : 0), 0)
}
