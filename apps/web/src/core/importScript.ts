/**
 * Bring a script in from a file. Plain text and Markdown are read as-is,
 * with Markdown's decorations stripped to what the prompter understands:
 * headings stay as `#` sections, emphasis and links become plain words.
 */

export const IMPORT_ACCEPT = '.txt,.md,.markdown,.text,text/plain,text/markdown'

export function isImportable(file: File): boolean {
  return /\.(txt|md|markdown|text)$/i.test(file.name) || file.type === 'text/plain' || file.type === 'text/markdown'
}

export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Untitled'
}

/** Markdown to prompter text. Keeps `#` headings, blank-line paragraphs and `[cues]`. */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^```[\s\S]*?^```\s*$/gm, '') // code fences
    .replace(/^#{1,6}[ \t]*/gm, '# ') // any heading level becomes a section
    .replace(/!\[[^\]]*]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1') // links keep their text
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2') // italics
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^[ \t]*>[ \t]?/gm, '') // quotes
    .replace(/^[ \t]*[-*+][ \t]+/gm, '') // bullets
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '') // numbered lists
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '') // rules
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function readScriptFile(file: File): Promise<{ title: string; text: string }> {
  const raw = await file.text()
  const text = /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown' ? cleanMarkdown(raw) : raw.replace(/\r\n?/g, '\n').trim()
  return { title: titleFromFilename(file.name), text }
}
