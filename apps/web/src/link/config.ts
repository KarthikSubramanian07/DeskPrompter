/**
 * Where the signaling relay lives. Override per environment with
 * `VITE_RELAY_URL` (e.g. `ws://127.0.0.1:8787` against `wrangler dev`).
 */
export const DEFAULT_RELAY_URL = 'wss://deskprompter-relay.karthik-e5e.workers.dev'

export const RELAY_URL: string = (import.meta.env.VITE_RELAY_URL as string | undefined) || DEFAULT_RELAY_URL

/** Public STUN only: no TURN, so no media or data ever transits a third party. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
]

/** How long a WebRTC attempt may take before the link settles on the relay. */
export const P2P_TIMEOUT_MS = 5_000
