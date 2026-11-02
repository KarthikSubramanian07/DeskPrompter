/**
 * Picks which upcoming script words to bias the recognizer toward.
 *
 * Every engine already knows "the", "and" and "today". What it gets wrong are
 * names, jargon and long words: "Kubernetes", "Okonkwo", "DeskPrompter". So
 * from the next stretch of script we drop stopwords, dedupe, and rank what's
 * left by how unusual it looks. Pure functions, no DOM.
 */

/** The very common words a recognizer never needs help with. Never hinted. */
const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are aren't as at be because been before being below " +
    "between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each " +
    "few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself " +
    "him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's me more most " +
    "mustn't my myself no nor not now of off on once only or other ought our ours ourselves out over own same " +
    "shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves " +
    "then there there's these they they'd they'll they're they've this those through to too under until up us very " +
    "was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's " +
    "whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves " +
    "yes yeah oh ok okay also well get got go going gonna want really"
  ).split(' '),
)

/** Everyday words: allowed as hints, but ranked well below anything unusual. */
const COMMON = new Set(
  (
    'able across actually again ago almost along already always another anything around ask away back bad best ' +
    'better big bit body book call came care case change child children city close come coming company could ' +
    'country course day days different done door each early end enough even ever every everyone everything eye ' +
    'eyes face fact family far feel felt find first five four friend friends gave give given good great group ' +
    'grow hand hands happen hard head hear heard help high home hope house idea important keep kind knew know ' +
    'last later least leave left less life light like line little live long look looking lot love made make ' +
    'making man many matter may maybe mean men might mind minute moment money month morning mother much must ' +
    'name need never new next nice night nothing number often old one open order part people perhaps person ' +
    'place play point power problem put question quite rather read real reason right room run said say says ' +
    'school second see seem seen set several show side since small something sometimes soon sort start started ' +
    'still stop story sure take talk team tell than thank thanks thing things think thought three time times ' +
    'today together told took top toward turn two understand upon use used way week went whole why without ' +
    'woman women word words work world year years yet young first last next today tonight welcome everybody ' +
    'evening hello hi'
  ).split(' '),
)

export interface RankOptions {
  /** Most hints to return. Default 24. */
  max?: number
  /** The script word just before `words[0]`, so a capital there isn't mistaken for a name. */
  prev?: string
}

export interface RankedHint {
  /** The word as written in the script, minus surrounding punctuation. */
  text: string
  /** 0..1, higher means rarer and more worth biasing toward. */
  weight: number
}

export interface HintOptions {
  /** How many script words after the cursor to consider. Default 40. */
  window?: number
  /** Most hints to return. Default 24. */
  max?: number
}

/** Strip surrounding punctuation, keeping inner apostrophes and hyphens ("don't", "on-device"). */
export function cleanWord(raw: string): string {
  return raw
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[\u2010-\u2014]/g, '-')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

const endsSentence = (raw: string | undefined) => raw === undefined || /[.!?:;]["'”’)\]]*$/.test(raw)

/** How unusual a cleaned word looks, 0..1. */
function rarity(word: string, sentenceStart: boolean): number {
  const lower = word.toLowerCase()
  let score = COMMON.has(lower) ? 0.1 : 0.45
  score += Math.min(word.length, 12) / 12 / 4 // long words: up to +0.25
  const capital = /^\p{Lu}/u.test(word)
  if (/^\p{Lu}{2,}$/u.test(word)) score += 0.25 // acronyms: NASA, API
  else if (capital && !sentenceStart) score += 0.2 // proper nouns mid-sentence
  if (/\p{Ll}\p{Lu}/u.test(word)) score += 0.15 // inner capitals: DeskPrompter, iPhone
  if (/\p{N}/u.test(word)) score += 0.1
  if (word.includes('-')) score += 0.05
  return Math.min(1, Math.round(score * 100) / 100)
}

/**
 * Rank a list of words as hints: clean, drop stopwords and fragments, dedupe
 * (case-insensitively, keeping the first spelling), and sort rarest first.
 * Ties keep script order. Idempotent: ranking its own output changes nothing
 * but the weights of words that were sentence-initial.
 */
export function rankHints(words: readonly string[], opts: RankOptions = {}): RankedHint[] {
  const max = opts.max ?? 24
  const seen = new Map<string, { hint: RankedHint; order: number }>()
  words.forEach((raw, i) => {
    const text = cleanWord(raw)
    const key = text.toLowerCase()
    if (text.length < 2 && !/\p{N}/u.test(text)) return
    if (STOPWORDS.has(key) || /^\p{N}{1,2}$/u.test(text)) return
    const weight = rarity(text, endsSentence(i === 0 ? opts.prev : words[i - 1]))
    const prev = seen.get(key)
    if (prev) prev.hint.weight = Math.max(prev.hint.weight, weight)
    else seen.set(key, { hint: { text, weight }, order: i })
  })
  return [...seen.values()]
    .sort((a, b) => b.hint.weight - a.hint.weight || a.order - b.order)
    .slice(0, max)
    .map((e) => e.hint)
}

/**
 * The hint words for the stretch of script after `cursor` (the last spoken
 * word index, -1 before the first). Returns plain strings, rarest first, ready
 * for `SpeechEngine.setHints`.
 */
export function pickHintWords(words: readonly string[], cursor: number, opts: HintOptions = {}): string[] {
  const from = Math.max(0, cursor + 1)
  const to = Math.min(words.length, from + (opts.window ?? 40))
  if (from >= to) return []
  return rankHints(words.slice(from, to), { max: opts.max, prev: words[from - 1] }).map((h) => h.text)
}

/** Map a 0..1 hint weight onto a SpeechRecognitionPhrase boost (spec default 1.0). */
export function hintBoost(weight: number, min = 1, max = 5): number {
  const w = Math.min(1, Math.max(0, weight))
  return Math.round((min + (max - min) * w) * 10) / 10
}
