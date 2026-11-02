/** The first-visit "how to start" card: shown until dismissed or until the first read. */
import { signal } from '@preact/signals'

const KEY = 'dp.guideDone.v1'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== null
  } catch {
    return false
  }
}

export const guideDone = signal(read())

export function dismissGuide() {
  guideDone.value = true
  try {
    localStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* private mode: it just shows again next time */
  }
}
