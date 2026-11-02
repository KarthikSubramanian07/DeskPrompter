/** The hanko: a vermilion seal with 机 (desk). */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" class="mark">
      <rect x="1.5" y="1.5" width="21" height="21" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6" />
      <text x="12" y="17.2" text-anchor="middle" font-size="14" fill="currentColor" style="font-family: var(--mincho)">
        机
      </text>
    </svg>
  )
}
