import { describe, expect, it } from 'vitest'
import { linkForScript, readLinkedScript } from './deeplink'

describe('deep links', () => {
  it('round-trips a script with a title, including spaces, newlines and symbols', () => {
    const text = '# Opening\n\nHello & welcome. [smile] 100% ready? Yes!'
    const url = new URL(linkForScript(text, 'My talk'))
    expect(url.pathname).toBe('/studio')
    expect(readLinkedScript(url.hash)).toEqual({ title: 'My talk', text })
  })
  it('accepts hand-written links with %20 and + for spaces', () => {
    expect(readLinkedScript('#title=Hi%20there&script=One+two%0A%0AThree')).toEqual({ title: 'Hi there', text: 'One two\n\nThree' })
  })
  it('defaults the title and ignores fragments without a script', () => {
    expect(readLinkedScript('#script=Hello')?.title).toBe('From a link')
    expect(readLinkedScript('')).toBeNull()
    expect(readLinkedScript('#title=Only')).toBeNull()
    expect(readLinkedScript('#script=%20%20')).toBeNull()
  })
})
