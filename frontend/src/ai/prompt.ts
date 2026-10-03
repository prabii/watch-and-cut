import type { SampledFrame } from '../analyze/frames'

export const SYSTEM_PROMPT = `You are a video editor that turns a user's request into a JSON edit plan.
You never edit pixels. You only choose which parts of ONE source video to keep, in order, and what text to show.

Return ONLY one JSON object, no prose, no markdown fences.

Schema:
{
  "status": "ok",
  "summary": string,                       // one short sentence describing the reel
  "operations": [                          // allowed ops only:
    { "op": "keep_segment", "start": number, "end": number, "reason": string },
    { "op": "add_caption", "segment": number, "text": string },
    { "op": "add_title", "text": string, "duration": number },
    { "op": "add_transition", "after_segment": number, "kind": "fade" | "slide" | "wipe" }
  ]
}
or, if the request needs anything other than these operations (new visuals, effects, music, other videos, colour grading, etc.):
{ "status": "unsupported", "reason": string }

Rules:
- Times are seconds in the SOURCE video, 0 ≤ start < end ≤ video duration. Each kept segment ≥ 1 second.
- When speech segments are listed, each one names the frame that shows its middle. Judge a segment by that frame.
- Build the reel from whole segments: copy a segment's exact start and end into keep_segment, so cuts never land mid-sentence.
- Kept segments must not overlap. They play in time order.
- "segment" and "after_segment" are 0-based indexes into your keep_segment list.
- At most one caption per segment; captions ≤ 60 characters, punchy, no hashtags.
- If the user gives a target length, the kept segments must add up to roughly that length.
- Use the frames to pick visually strong, on-topic moments (faces, action, slides, reactions).`

export interface PromptInput {
  request: string
  duration: number
  frames: SampledFrame[]
  segments: { start: number; end: number }[]
  hasAudio: boolean
  targetSec?: number
  previous?: { output: string; feedback: string } // refine or validation retry
}

export function buildUserPrompt(p: PromptInput): string {
  const lines: string[] = []
  lines.push(`USER REQUEST: ${p.request}`)
  lines.push('')
  lines.push(`Video duration: ${p.duration.toFixed(1)}s`)
  if (p.targetSec) lines.push(`Target reel length: about ${p.targetSec}s`)
  lines.push('')
  if (p.hasAudio) {
    lines.push('Speech segments detected from audio pauses (start–end, seconds):')
    lines.push(
      p.segments
        .map((s, i) => {
          const f = p.frames.findIndex((fr) => fr.segment === i)
          return `S${i}: ${s.start.toFixed(1)}–${s.end.toFixed(1)}${f >= 0 ? ` (see Frame ${f + 1})` : ''}`
        })
        .join('\n'),
    )
  } else {
    lines.push('No audio track: choose segment times from the frames.')
  }
  lines.push('')
  lines.push(`${p.frames.length} frames are attached in order, at these times:`)
  lines.push(
    p.frames.map((f, i) => `Frame ${i + 1} @ ${f.time.toFixed(1)}s${f.segment !== undefined ? ` (S${f.segment})` : ''}`).join(', '),
  )
  if (p.previous) {
    lines.push('')
    lines.push('YOUR PREVIOUS PLAN:')
    lines.push(p.previous.output)
    lines.push('')
    lines.push(`FIX THIS: ${p.previous.feedback}`)
    lines.push('Return a complete new plan (all operations), not a diff.')
  }
  return lines.join('\n')
}
