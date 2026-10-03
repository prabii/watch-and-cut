export interface SampledFrame {
  time: number // seconds
  base64: string // JPEG, no data: prefix
  dataUrl: string // for thumbnails in the UI
  segment?: number // index of the speech segment this frame represents
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      reject(new Error('Could not read video frame'))
    }
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    video.currentTime = time
  })
}

export interface FrameSample {
  frames: SampledFrame[]
  duration: number
  width: number
  height: number
}

/**
 * Grab frames as downscaled JPEGs (long edge `maxEdge` px).
 * `at` is either a count (evenly spaced) or explicit times in seconds.
 */
export async function sampleFrames(src: string, at: number | number[], maxEdge = 512): Promise<FrameSample> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = src
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error('Could not load video for analysis'))
  })

  const duration = video.duration
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const ctx = canvas.getContext('2d')!

  const frames: SampledFrame[] = []
  // Centre of each of `count` equal slices, so we never sample the exact first/last frame.
  const times = Array.isArray(at) ? at : Array.from({ length: at }, (_, i) => ((i + 0.5) / at) * duration)
  for (const t of times) {
    const time = Math.min(duration - 0.05, Math.max(0, t))
    await seek(video, time)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    frames.push({ time: Math.round(time * 10) / 10, dataUrl, base64: dataUrl.split(',')[1] })
  }
  video.removeAttribute('src')
  const result = { frames, duration, width: video.videoWidth, height: video.videoHeight }
  video.load()
  return result
}
