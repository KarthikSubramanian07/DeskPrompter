/**
 * Every app page ships readable HTML inside #app for crawlers and agents that
 * don't run JavaScript. Mounting clears it and tells the boot script we made it.
 */
export function mountPoint(id = 'app'): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  el.textContent = ''
  ;(window as unknown as { __dpMounted?: boolean }).__dpMounted = true
  return el
}
