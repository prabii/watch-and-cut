import type { SampledFrame } from '../analyze/frames'
import type { AudioAnalysis } from '../analyze/silence'
import { requestPlan, type ModelTarget } from '../ai/client'
import { SYSTEM_PROMPT, buildUserPrompt } from '../ai/prompt'
import type { ValidPlan } from './schema'
import { parseTargetSeconds, validatePlan } from './validate'

export interface Analysis {
  duration: number
  frames: SampledFrame[]
  audio: AudioAnalysis
}

export interface Attempt {
  output: string
  model: string
  ms: number
  errors?: string[]
}

export type GenerateResult =
  | { kind: 'valid'; plan: ValidPlan; rawOutput: string; attempts: Attempt[] }
  | { kind: 'unsupported'; reason: string; attempts: Attempt[] }
  | { kind: 'invalid'; errors: string[]; attempts: Attempt[] }

export type Step = 'asking' | 'validating' | 'correcting'

function pickFrames(frames: SampledFrame[], n: number) {
  if (frames.length <= n) return frames
  return Array.from({ length: n }, (_, i) => frames[Math.floor(((i + 0.5) / n) * frames.length)])
}

/**
 * request → model → validate → (one self-correction retry) → result.
 * `refine` carries the previous plan and the user's feedback.
 */
export async function generatePlan(opts: {
  target: ModelTarget
  maxFrames: number
  request: string
  analysis: Analysis
  refine?: { output: string; feedback: string }
  signal?: AbortSignal
  onStep?: (step: Step) => void
}): Promise<GenerateResult> {
  const { request, analysis } = opts
  const frames = pickFrames(analysis.frames, opts.maxFrames)
  const targetSec = parseTargetSeconds(opts.refine ? `${request} ${opts.refine.feedback}` : request)
  const ctx = { duration: analysis.duration, pauses: analysis.audio.pauses, targetSec }
  const attempts: Attempt[] = []

  let previous = opts.refine
  for (let attempt = 0; attempt < 2; attempt++) {
    opts.onStep?.(attempt === 0 ? 'asking' : 'correcting')
    const user = buildUserPrompt({
      request,
      duration: analysis.duration,
      frames,
      segments: analysis.audio.segments,
      hasAudio: analysis.audio.hasAudio,
      targetSec,
      previous,
    })
    const reply = await requestPlan(opts.target, SYSTEM_PROMPT, user, frames.map((f) => f.base64), opts.signal)
    opts.onStep?.('validating')
    const result = validatePlan(reply.text, ctx)
    const record: Attempt = { output: reply.text, model: reply.model, ms: reply.ms }
    attempts.push(record)

    if (result.kind === 'valid') return { kind: 'valid', plan: result.plan, rawOutput: reply.text, attempts }
    if (result.kind === 'unsupported') return { kind: 'unsupported', reason: result.reason, attempts }

    record.errors = result.errors
    const last = attempt === 1
    if (last && result.soft && result.fallback) {
      return { kind: 'valid', plan: result.fallback, rawOutput: reply.text, attempts }
    }
    if (last) return { kind: 'invalid', errors: result.errors, attempts }
    previous = { output: reply.text, feedback: `Your plan failed validation: ${result.errors.join('; ')}` }
  }
  return { kind: 'invalid', errors: ['No valid plan'], attempts }
}
