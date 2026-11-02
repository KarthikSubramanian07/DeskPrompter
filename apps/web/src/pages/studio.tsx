import { render } from 'preact'
import { useComputed, useSignal } from '@preact/signals'
import { useEffect, useMemo } from 'preact/hooks'
import '../styles/base.css'
import './studio.css'
import { parseScriptTS } from '../core/script'
import { currentId, hydrate, ready, scripts, settings } from '../core/store'
import { Mark } from '../ui/Mark'
import { Desk } from '../ui/studio/Desk'
import { Stage } from '../ui/studio/Stage'
import { Kbd } from '../ui/studio/controls'

function Studio() {
  const view = useSignal<'desk' | 'stage'>('desk')
  const script = useComputed(() => scripts.value.find((s) => s.id === currentId.value))
  const text = script.value?.text ?? ''
  const parsed = useMemo(() => parseScriptTS(text), [text])

  useEffect(() => {
    void hydrate()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.value.theme
  }, [settings.value.theme])

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
    <div class="studio grain">
      {view.value === 'desk' ? (
        <>
          <header class="bar">
            <a class="brand" href="/" aria-label="DeskPrompter home">
              <Mark />
              <span>DeskPrompter</span>
            </a>
            <div class="bar-right">
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
        <Stage script={script.value} parsed={parsed} onExit={() => (view.value = 'desk')} />
      )}
    </div>
  )
}

render(<Studio />, document.getElementById('app')!)
