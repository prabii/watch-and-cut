// Deterministic speech/pause detection. No AI: finds natural cut points so the model
// chooses between real segments instead of inventing timestamps.

export interface AudioAnalysis {
  hasAudio: boolean
  pauses: number[] // seconds, centre of each detected pause
  segments: { start: number; end: number }[] // spoken stretches between pauses
}

const WINDOW_SEC = 0.1
const MIN_PAUSE_SEC = 0.3
const MIN_SEGMENT_SEC = 1.0
const MAX_SEGMENTS = 40

export async function analyzeAudio(src: string, durationSec: number): Promise<AudioAnalysis> {
  const none: AudioAnalysis = { hasAudio: false, pauses: [], segments: [{ start: 0, end: durationSec }] }
  let buffer: AudioBuffer
  try {
    const bytes = await (await fetch(src)).arrayBuffer()
    const ctx = new AudioContext()
    buffer = await ctx.decodeAudioData(bytes)
    void ctx.close()
  } catch {
    return none // video without an audio track, or an undecodable codec
  }

  const data = buffer.getChannelData(0)
  const win = Math.max(1, Math.floor(buffer.sampleRate * WINDOW_SEC))
  const rms: number[] = []
  for (let i = 0; i < data.length; i += win) {
    let sum = 0
    const end = Math.min(data.length, i + win)
    for (let j = i; j < end; j++) sum += data[j] * data[j]
    rms.push(Math.sqrt(sum / (end - i)))
  }
  if (rms.length === 0) return none

  // Threshold relative to typical loudness, so it adapts to quiet and loud recordings.
  const sorted = [...rms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const threshold = Math.max(0.005, median * 0.35)

  const pauses: number[] = []
  let runStart = -1
  for (let i = 0; i <= rms.length; i++) {
    const quiet = i < rms.length && rms[i] < threshold
    if (quiet && runStart < 0) runStart = i
    if (!quiet && runStart >= 0) {
      if ((i - runStart) * WINDOW_SEC >= MIN_PAUSE_SEC) {
        pauses.push(round1(((runStart + i) / 2) * WINDOW_SEC))
      }
      runStart = -1
    }
  }

  // Segments between pauses; merge short ones so the model sees a manageable list.
  const bounds = [0, ...pauses.filter((p) => p > 0.2 && p < durationSec - 0.2), durationSec]
  let segments = bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }))
  segments = mergeShort(segments)
  while (segments.length > MAX_SEGMENTS) segments = mergeAdjacentPairs(segments)

  return { hasAudio: true, pauses, segments: segments.map((s) => ({ start: round1(s.start), end: round1(s.end) })) }
}

function mergeShort(segs: { start: number; end: number }[]) {
  const out: { start: number; end: number }[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.end - last.start < MIN_SEGMENT_SEC) last.end = s.end
    else out.push({ ...s })
  }
  const last = out[out.length - 1]
  if (out.length > 1 && last.end - last.start < MIN_SEGMENT_SEC) {
    out[out.length - 2].end = last.end
    out.pop()
  }
  return out
}

function mergeAdjacentPairs(segs: { start: number; end: number }[]) {
  const out: { start: number; end: number }[] = []
  for (let i = 0; i < segs.length; i += 2) {
    out.push({ start: segs[i].start, end: (segs[i + 1] ?? segs[i]).end })
  }
  return out
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * One frame per speech segment (its midpoint), so the model can judge each segment by its picture.
 * With more segments than `max`, an evenly spread subset is used.
 */
export function frameTimesForSegments(segments: { start: number; end: number }[], max: number) {
  const picks =
    segments.length <= max
      ? segments.map((_, i) => i)
      : Array.from({ length: max }, (_, i) => Math.floor(((i + 0.5) / max) * segments.length))
  return picks.map((i) => ({ segment: i, time: round1((segments[i].start + segments[i].end) / 2) }))
}
