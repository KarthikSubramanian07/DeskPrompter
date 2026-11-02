/** Pixel position of the caret inside a textarea, via a hidden mirror element. */
const PROPS = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth',
  'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'fontVariationSettings', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize',
] as const

let mirror: HTMLDivElement | null = null

export function caretXY(ta: HTMLTextAreaElement): { x: number; y: number } {
  if (!mirror) {
    mirror = document.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', top: '0', left: '-9999px' })
    document.body.append(mirror)
  }
  const cs = getComputedStyle(ta)
  for (const p of PROPS) (mirror.style as unknown as Record<string, string>)[p] = cs[p] as string
  mirror.textContent = ta.value.slice(0, ta.selectionEnd)
  const mark = document.createElement('span')
  mark.textContent = '​'
  mirror.append(mark)
  const r = ta.getBoundingClientRect()
  return { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || '20') * 0.5 }
}
