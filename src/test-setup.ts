import '@testing-library/jest-dom/vitest'
window.scrollTo = () => {}

// jsdom lacks IntersectionObserver / matchMedia; stub for components using reveal + nav.
class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'IntersectionObserver', { value: IO, writable: true })
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
})
