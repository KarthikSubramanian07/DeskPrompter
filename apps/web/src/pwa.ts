/**
 * Service worker registration. New versions install in the background and take
 * over as soon as it's safe: immediately on the landing page and the desk, but
 * never mid-read. If you're on stage, the update waits until you leave it.
 */
import { registerSW } from 'virtual:pwa-register'

let waiting = false
const safe = () => !document.querySelector('.stage')

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    waiting = true
    apply()
  },
})

function apply() {
  if (waiting && safe()) {
    waiting = false
    void updateSW(true)
  }
}

setInterval(apply, 2000)
addEventListener('visibilitychange', apply)
