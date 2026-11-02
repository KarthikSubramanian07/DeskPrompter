/** Small, quiet form controls in the house style. */
import type { ComponentChildren } from 'preact'

export function Section({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <section class="setup-sec">
      <h3 class="setup-label">{label}</h3>
      {children}
    </section>
  )
}

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onInput: (v: number) => void
}) {
  const { label, value, min, max, step = 1, format = String, onInput } = props
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label class="slider">
      <span class="slider-top">
        <span>{label}</span>
        <span class="slider-val">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pct': `${pct}%` }}
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
      />
    </label>
  )
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label class="toggle">
      <span class="toggle-text">
        <span>{label}</span>
        {hint && <span class="toggle-hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="toggle-track" aria-hidden="true">
        <span class="toggle-knob" />
      </span>
    </label>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string; icon?: ComponentChildren; title?: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div class="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o, index) => (
        <button
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          tabIndex={props.value === o.value ? 0 : -1}
          onKeyDown={(e) => {
            let next: number
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % props.options.length
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + props.options.length) % props.options.length
            else if (e.key === 'Home') next = 0
            else if (e.key === 'End') next = props.options.length - 1
            else return
            e.preventDefault()
            props.onChange(props.options[next]!.value)
            e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
          }}
          class={`seg-btn ${props.value === o.value ? 'on' : ''}`}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.icon && <span class="seg-icon">{o.icon}</span>}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>
}
