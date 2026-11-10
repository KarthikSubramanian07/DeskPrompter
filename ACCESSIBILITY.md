# Accessibility

DeskPrompter aims to meet **WCAG 2.2 Level AA** across all views and modes: the landing page, static documentation pages, the studio and desk, the reading stage, the talent window, and the phone remote.

## How it was checked

- **Automated:** axe-core 4.14 (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) in headless Chrome at three viewports: desktop (1440×900), mobile (390×844), and narrow reflow (320×800). All reachable views and states were audited (landing hero, scrolled, FAQ open, studio paper and dark themes, first-visit guide, mobile sheet drawers for scripts and settings, voice settings, pairing modal, reading stage in auto and voice modes, stage keys help modal, countdown, talent window, and phone remote connect and control states). axe reports 0 violations across all tested states and viewports.
- **Keyboard navigation:** Full keyboard operation on the desk and stage with visible focus rings (`:focus-visible`). Skip links to bypass navigation on the landing, docs, and studio. Modals and sliding sheets trap focus, restore focus to trigger buttons on dismiss, and close on Escape.
- **Motion:** The landing page provides a pause control for the animated lamp and demo. The app respects `prefers-reduced-motion` across animations, transitions, and the lamp rig.
- **Screen reader semantics:** Clear heading structure, landmark regions (`<main>`, `<nav>`, `<header>`), `aria-live` announcements for save status and phone remote connection errors, and descriptive names and states for all interactive controls.
- **Contrast & Reflow:** Contrast ratios meet or exceed 4.5:1 for body copy and 3:1 for large text and non-text UI components across paper and dark themes. Layouts reflow down to 320 px without horizontal clipping.

## Known limitations

- The camera check overlay on stage is a visual framing aid with no audio feedback.
- Speech recognition depends on browser-supported speech engines (on-device Chrome Speech API or Moonshine WebAssembly model) or microphone input; manual auto-scroll, keyboard navigation, and phone remote controls are provided as alternatives.

## Report a barrier

If you encounter an accessibility barrier or bug while using DeskPrompter, please open an issue on the GitHub repository describing the problem, the page or feature, and the assistive technology or device used.
