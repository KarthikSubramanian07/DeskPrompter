import type { Script } from './store'

/** Plain text preserves headings and cues and can be imported again. */
export function downloadScript(script: Pick<Script, 'title' | 'text'>) {
  const blob = new Blob([script.text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${script.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'Untitled'}.txt`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
