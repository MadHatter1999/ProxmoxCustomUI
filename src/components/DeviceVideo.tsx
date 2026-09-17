import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * Live H.264 view of a device.
 *
 * Polled screenshots top out near 3fps - every frame is a fresh screencap plus
 * a round trip. This instead reads the raw Annex-B elementary stream the agent
 * pipes out of the device's own encoder (screenrecord) and decodes it here with
 * WebCodecs, which is smooth video at the device's own frame rate.
 *
 * WebCodecs is Chromium-and-friends only, and a decode can fail on a mangled
 * chunk, so both cases call back to the caller and it drops to the screenshot
 * poll. The stream is deliberately NOT wrapped in a container: no MSE, no
 * mp4 muxing, just NAL units straight into the decoder.
 */

/** Loosely typed so this compiles on TS DOM libs that predate WebCodecs. */
interface CodecWindow {
  VideoDecoder?: new (init: { output: (f: VideoFrameLike) => void; error: (e: unknown) => void }) => DecoderLike
  EncodedVideoChunk?: new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown
}
interface DecoderLike {
  state: string
  configure(cfg: { codec: string; optimizeForLatency?: boolean }): void
  decode(chunk: unknown): void
  close(): void
}
interface VideoFrameLike {
  displayWidth: number
  displayHeight: number
  close(): void
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

export default function DeviceVideo({ src, className, onUnsupported, onError, onPointerDown, onPointerUp }: {
  src: string
  className?: string
  onUnsupported: () => void
  onError: (message: string) => void
  onPointerDown?: (e: ReactPointerEvent<HTMLCanvasElement>) => void
  onPointerUp?: (e: ReactPointerEvent<HTMLCanvasElement>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const w = window as unknown as CodecWindow
    if (!w.VideoDecoder || !w.EncodedVideoChunk) {
      onUnsupported()
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const abort = new AbortController()
    let decoder: DecoderLike | null = null
    let closed = false
    let frameNo = 0

    async function pump(): Promise<void> {
      const res = await fetch(src, { signal: abort.signal, cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`screen stream returned ${res.status}`)
      const reader = res.body.getReader()

      let buf = new Uint8Array(0)
      let sps: Uint8Array | null = null
      let pps: Uint8Array | null = null

      // The decoder can only be configured once we've seen an SPS, because the
      // profile/level in it is what names the codec.
      const ensureDecoder = () => {
        if (decoder || !sps || !w.VideoDecoder) return
        decoder = new w.VideoDecoder({
          output: frame => {
            if (!closed && ctx) {
              if (canvas!.width !== frame.displayWidth || canvas!.height !== frame.displayHeight) {
                canvas!.width = frame.displayWidth
                canvas!.height = frame.displayHeight
              }
              ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0)
            }
            frame.close()
          },
          error: () => { /* one bad chunk must not tear the view down */ }
        })
        decoder.configure({ codec: `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`, optimizeForLatency: true })
      }

      /** Re-frame NAL units as Annex-B and hand them to the decoder. */
      const emit = (nals: Uint8Array[], key: boolean) => {
        ensureDecoder()
        if (!decoder || decoder.state !== 'configured' || !w.EncodedVideoChunk) return
        const total = nals.reduce((n, x) => n + 4 + x.length, 0)
        const out = new Uint8Array(total)
        let o = 0
        for (const n of nals) {
          out[o + 3] = 1
          o += 4
          out.set(n, o)
          o += n.length
        }
        try {
          decoder.decode(new w.EncodedVideoChunk({
            type: key ? 'key' : 'delta',
            // screenrecord gives no timestamps; a monotonic 30fps clock is all
            // the decoder needs to keep ordering straight.
            timestamp: frameNo++ * 33_333,
            data: out
          }))
        } catch { /* skip the frame, keep the stream */ }
      }

      const drain = () => {
        // Index every start code, then treat each span between them as one NAL.
        const starts: Array<[at: number, len: number]> = []
        let i = 0
        while (i + 3 < buf.length) {
          if (buf[i] === 0 && buf[i + 1] === 0) {
            if (buf[i + 2] === 1) { starts.push([i, 3]); i += 3; continue }
            if (buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push([i, 4]); i += 4; continue }
          }
          i++
        }
        if (starts.length < 2) return
        for (let s = 0; s < starts.length - 1; s++) {
          const nal = buf.subarray(starts[s][0] + starts[s][1], starts[s + 1][0])
          if (!nal.length) continue
          const type = nal[0] & 0x1f
          if (type === 7) sps = nal.slice()
          else if (type === 8) pps = nal.slice()
          else if (type === 5) emit(sps && pps ? [sps, pps, nal.slice()] : [nal.slice()], true)
          else if (type === 1) emit([nal.slice()], false)
        }
        // Keep the trailing (possibly incomplete) NAL for the next read.
        buf = buf.slice(starts[starts.length - 1][0])
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done || closed) return
        const next = new Uint8Array(buf.length + value.length)
        next.set(buf, 0)
        next.set(value, buf.length)
        buf = next
        drain()
      }
    }

    pump().catch(err => {
      if (closed || abort.signal.aborted) return
      onError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      closed = true
      abort.abort()
      try { decoder?.close() } catch { /* already gone */ }
    }
  }, [src, onUnsupported, onError])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    />
  )
}
