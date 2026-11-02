/** One place for what each scroll mode is called and what it does, in plain words. */
import type { PrompterMode } from './contracts'

export interface ModeCopy {
  label: string
  summary: string
  needsMic: boolean
}

export const MODE_COPY: Record<PrompterMode, ModeCopy> = {
  voice: {
    label: 'Voice follow',
    summary: 'Listens as you read and keeps your place. Skip, stumble or ad-lib and it keeps up.',
    needsMic: true,
  },
  breath: {
    label: 'Talk to scroll',
    summary: 'Scrolls while you are talking and pauses when you stop. Works in any language.',
    needsMic: true,
  },
  manual: {
    label: 'Auto scroll',
    summary: 'Scrolls at a steady speed you choose.',
    needsMic: false,
  },
}

/** The order modes appear in, simplest first. */
export const MODE_ORDER: PrompterMode[] = ['manual', 'voice', 'breath']

export const widthLabel = (ch: number) => (ch < 22 ? 'Narrow' : ch < 34 ? 'Medium' : 'Wide')
export const spacingLabel = (lh: number) => (lh < 1.22 ? 'Tight' : lh < 1.5 ? 'Normal' : 'Loose')
export const micLabel = (v: number) => (v < 34 ? 'Loud voices only' : v < 67 ? 'Normal' : 'Picks up quiet voices')
