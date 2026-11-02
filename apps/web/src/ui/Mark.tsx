/** The mark: a little desk lamp, bulb lit. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" class="mark">
      <path
        d="M10.6 7.4c-.3-1 .2-2 1.2-2.3l1.9-.6c1-.3 1.9.2 2.3 1.1L23.6 15c.4.6.1 1.3-.6 1.5l-8.9 2.6c-.7.2-1.3-.3-1.3-1Z"
        fill="currentColor"
      />
      <circle cx="18.7" cy="18.3" r="2.1" fill="var(--amber-hi, #f2c27e)" />
      <path d="M11.4 9.2 6.6 16.2l4.4 9.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M4.5 26.4h13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  )
}
