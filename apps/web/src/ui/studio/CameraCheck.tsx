/**
 * A small mirrored self-view pinned under the lens, so you can check framing
 * and keep your eyes near the camera. Video never leaves the element.
 */
import { useEffect, useRef, useState } from 'preact/hooks'

export function CameraCheck() {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<'starting' | 'on' | 'denied'>('starting')

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (video.current) video.current.srcObject = s
        setState('on')
      })
      .catch(() => setState('denied'))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <figure class={`cam cam-${state}`} aria-label="Camera check">
      <video ref={video} autoplay playsInline muted />
      {state !== 'on' && <figcaption>{state === 'denied' ? 'Camera unavailable' : 'Camera…'}</figcaption>}
      <span class="cam-dot" aria-hidden="true" />
    </figure>
  )
}
