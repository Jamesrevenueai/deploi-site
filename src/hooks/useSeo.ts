import { useEffect } from 'react'

const SITE_ORIGIN = 'https://getdeploi.com'

type SeoOpts = {
  title: string
  description: string
}

function upsertMeta(selector: string, attr: 'name' | 'property', key: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(selector)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

/** Sets <title>, description, canonical URL, and Open Graph / Twitter tags on mount. */
export function useSeo({ title, description }: SeoOpts) {
  useEffect(() => {
    document.title = title
    upsertMeta('meta[name="description"]', 'name', 'description', description)
    upsertMeta('meta[property="og:title"]', 'property', 'og:title', title)
    upsertMeta('meta[property="og:description"]', 'property', 'og:description', description)
    upsertMeta('meta[property="og:type"]', 'property', 'og:type', 'website')
    upsertMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title)
    upsertMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description)
    // canonical and og:url follow the route (index.html ships the homepage's)
    const url = `${SITE_ORIGIN}${window.location.pathname === '/' ? '/' : window.location.pathname.replace(/\/+$/, '')}`
    upsertMeta('meta[property="og:url"]', 'property', 'og:url', url)
    let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link) }
    link.href = url
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [title, description])
}
