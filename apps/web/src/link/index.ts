/**
 * Device link: pair a phone remote or a talent display with the prompter.
 *
 * - `createLocalLink`: same device, other windows (BroadcastChannel).
 * - `createRemoteLink`: other devices, WebRTC data channel with relay fallback.
 */

export { createLocalLink } from './broadcast'
export { createRemoteLink, RelayClose, type RemoteLink, type RemoteLinkOptions } from './relay'
export { generateRoomCode, normalizeRoomCode, isRoomCode, pairUrl, formatRoomCode, ROOM_CODE_ALPHABET } from './code'
export { parseLinkMessage, decodeLinkMessage, encodeLinkMessage } from './message'
export { qrSvg, type QrOptions } from './qr'
export { RELAY_URL, ICE_SERVERS } from './config'
export { useLink, type UseLink } from './useLink'
