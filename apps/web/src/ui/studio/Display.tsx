/**
 * Talent display: a second window (or a second screen under glass) that
 * follows the operator. It receives the script and the scroll position over
 * a same-device channel and never needs the network.
 */
import { useSignal } from '@preact/signals'
import { useEffect, useMemo, useRef } from 'preact/hooks'
import type { PrompterSnapshot } from '../../core/contracts'
import { aligner, loadAlignerOnce, parseScript } from '../../core/parser'
import type { Prompter } from '../../core/prompter'
import { createLocalLink } from '../../link/broadcast'
import { Stage } from './Stage'

export function Display({ mirrorX }: { mirrorX: boolean }) {
  const script = useSignal<{ title: string; text: string } | null>(null)
  const mirror = useSignal({ x: mirrorX, y: false })
  const prompter = useRef<Prompter | null>(null)
  const last = useRef<PrompterSnapshot | null>(null)
  const parsed = useMemo(() => parseScript(script.value?.text ?? ''), [script.value?.text, aligner.value])

  useEffect(() => {
    document.title = 'Talent · DeskPrompter'
    void loadAlignerOnce()
    const link = createLocalLink('display')
    const off = link.onMessage((m) => {
      if (m.t === 'script') script.value = { title: m.title, text: m.text }
      else if (m.t === 'state') {
        last.current = m.s
        prompter.current?.seekProgress(m.s.progress)
      } else if (m.t === 'bye') script.value = null
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'm') mirror.value = { ...mirror.value, x: !mirror.value.x }
      if (e.key === 'f') document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.()
    }
    addEventListener('keydown', onKey)
    return () => {
      off()
      link.close()
      removeEventListener('keydown', onKey)
    }
  }, [])

  if (!script.value)
    return (
      <main class="display-wait">
        <h1 class="display-wait-title">Talent window</h1>
        <p role="status">Waiting for the studio. Keep DeskPrompter open in another window on this computer.</p>
        <p class="display-wait-keys">Press F for fullscreen, M to mirror.</p>
      </main>
    )

  return (
    <Stage
      display
      script={{ id: 'display', title: script.value.title, text: script.value.text, updatedAt: 0 }}
      parsed={parsed}
      mirror={mirror.value}
      onExit={() => {}}
      onReady={({ prompter: p }) => {
        prompter.current = p
        if (last.current) p.seekProgress(last.current.progress)
      }}
    />
  )
}
