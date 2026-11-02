import { render } from 'preact'
import { useComputed, useSignal } from '@preact/signals'
import { useEffect, useMemo } from 'preact/hooks'
import '../styles/base.css'
import '../pwa'
import './studio.css'
import { aligner, loadAlignerOnce, parseScript } from '../core/parser'
import { currentId, hydrate, ready, scripts, settings } from '../core/store'
import { Mark } from '../ui/Mark'
import { Desk, deskSheet } from '../ui/studio/Desk'
import { Stage } from '../ui/studio/Stage'
import { Kbd } from '../ui/studio/controls'
import { PairButton, TalentButton } from '../ui/studio/Pair'
import { HostBridge } from '../core/bridge'
import { Display } from '../ui/studio/Display'

const params = new URLSearchParams(location.search)
const IS_DISPLAY = params.has('display')
const bridge = IS_DISPLAY ? null : new HostBridge()
addEventListener('pagehide', () => bridge?.close())

function Studio() {
  const view = useSignal<'desk' | 'stage'>('desk')
  const script = useComputed(() => scripts.value.find((s) => s.id === currentId.value))
  const text = script.value?.text ?? ''
  const parsed = useMemo(() => parseScript(text), [text, aligner.value])

  useEffect(() => {
    void hydrate()
    void loadAlignerOnce()
  }, [])

  useEffect(() => {
    if (script.value) bridge?.setScript(script.value.title, script.value.text)
  }, [script.value?.title, script.value?.text])


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view.value === 'desk' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        view.value = 'stage'
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready.value || !script.value) return <div class="boot" />

  return (
    <div class={`studio grain ${settings.value.theme === 'paper' ? 'day' : 'night'}`}>
      {view.value === 'desk' ? (
        <>
          <header class="bar">
            <a class="brand" href="/" aria-label="DeskPrompter home">
              <Mark />
              <span>DeskPrompter</span>
            </a>
            <div class="bar-right">
              <button class="bar-btn bar-sheet bar-sheet-scripts" onClick={() => (deskSheet.value = 'scripts')}>
                Scripts
              </button>
              <button class="bar-btn bar-sheet bar-sheet-setup" onClick={() => (deskSheet.value = 'setup')}>
                Settings
              </button>
              {bridge && <TalentButton />}
              {bridge && <PairButton bridge={bridge} />}
              <span class="bar-privacy" title="Scripts are stored in this browser. Nothing is uploaded.">
                <span class="dot-sage" /> Private, works offline
              </span>
              <button class="btn-go" onClick={() => (view.value = 'stage')}>
                <span>Go</span>
                <span class="btn-go-kbd">
                  <Kbd>⌘</Kbd>
                  <Kbd>↵</Kbd>
                </span>
              </button>
            </div>
          </header>
          <Desk />
        </>
      ) : (
        <Stage script={script.value} parsed={parsed} bridge={bridge ?? undefined} onExit={() => (view.value = 'desk')} />
      )}
    </div>
  )
}

render(IS_DISPLAY ? <Display mirrorX={params.get('mirror') === '1'} /> : <Studio />, document.getElementById('app')!)
