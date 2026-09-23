import { useEffect } from 'react'

/**
 * Attach IntersectionObserver to any `.reveal` element and add `.revealed`
 * on first intersection. Re-attaches on DOM churn so newly-mounted content
 * animates in too. Respects `prefers-reduced-motion`.
 */
export function useScrollReveal() {
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('revealed'))
      return
    }
    const io = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed')
            io.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    )

    let mounted = true
    const attach = () => {
      if (!mounted) return
      document.querySelectorAll('.reveal:not(.revealed)').forEach(el => io.observe(el))
    }
    attach()
    const mo = new MutationObserver(attach)
    mo.observe(document.body, { childList: true, subtree: true })

    return () => {
      mounted = false
      io.disconnect()
      mo.disconnect()
    }
  }, [])
}
