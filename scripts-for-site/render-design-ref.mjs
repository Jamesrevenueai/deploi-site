/**
 * Renders the approved design-ref screens (design-ref/*.html) to static HTML so they can be screenshotted next to
 * the live build. The design files use a small component runtime (support.js, not provided): an <x-dc> template with
 * {{ expr }} bindings, <sc-for list= as=>, <sc-if value=>, <helmet> for <head> content, and a
 * `class Component extends DCLogic` whose renderVals() returns the values. This script runs that class in Node
 * (with an optional initial state, e.g. the Office workspace) and expands the template. Event handlers are dropped.
 *
 *   node scripts-for-site/render-design-ref.mjs            -> design-ref/rendered/<name>[.<variant>].html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'design-ref')
const out = join(dir, 'rendered')
mkdirSync(out, { recursive: true })

class DCLogic { constructor(p) { this.props = p ?? {}; this.state = {} } setState(s) { this.state = { ...this.state, ...s } } }

function component(src) {
  const code = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(src)[1]
  return new Function('DCLogic', `${code}\nreturn Component;`)(DCLogic)
}

const get = (scope, expr) => {
  expr = expr.trim()
  if (expr === 'false') return false
  if (expr === 'true') return true
  return expr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope)
}
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Find the matching close tag for a block element, honouring nesting. */
function block(tpl, tag, start) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'g'), close = new RegExp(`</${tag}>`, 'g')
  let depth = 0, i = start
  for (;;) {
    open.lastIndex = i; close.lastIndex = i
    const o = open.exec(tpl), c = close.exec(tpl)
    if (!c) throw new Error(`unclosed <${tag}>`)
    if (o && o.index < c.index) { depth++; i = o.index + o[0].length } else { depth--; i = c.index + c[0].length; if (depth === 0) return { end: c.index, after: i } }
  }
}

function render(tpl, scope) {
  let outStr = '', i = 0
  const re = /<(sc-for|sc-if)\b([^>]*)>/g
  for (;;) {
    re.lastIndex = i
    const m = re.exec(tpl)
    if (!m) { outStr += interp(tpl.slice(i), scope); break }
    outStr += interp(tpl.slice(i, m.index), scope)
    const { end, after } = block(tpl, m[1], m.index)
    const inner = tpl.slice(m.index + m[0].length, end)
    const attr = n => (new RegExp(`${n}="\\{\\{([^}]*)\\}\\}"`).exec(m[2]) ?? [])[1]
    if (m[1] === 'sc-for') {
      const list = get(scope, attr('list')) ?? [], as = /as="([^"]+)"/.exec(m[2])[1]
      for (const item of list) outStr += render(inner, { ...scope, [as]: item })
    } else if (get(scope, attr('value'))) outStr += render(inner, scope)
    i = after
  }
  return outStr
}

function interp(s, scope) {
  // drop event handlers; bind attribute and text expressions
  return s.replace(/\s(on[A-Z]\w*)="\{\{[^}]*\}\}"/g, '')
    .replace(/(\s[\w-]+)="\{\{([^}]*)\}\}"/g, (_, a, e) => { const v = get(scope, e); return v === false || v == null ? (a.trim().startsWith('aria-') ? `${a}="false"` : '') : `${a}="${esc(v)}"` })
    .replace(/\{\{([^}]*)\}\}/g, (_, e) => esc(get(scope, e)))
}

function page(file, state, suffix) {
  const src = readFileSync(join(dir, file), 'utf8')
  const C = component(src)
  const c = new C({})
  if (state) c.state = { ...c.state, ...state }
  const vals = c.renderVals()
  const title = /<title>([\s\S]*?)<\/title>/.exec(src)[1]
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(src)[1]
  const body = /<x-dc>[\s\S]*?<\/helmet>([\s\S]*?)<\/x-dc>/.exec(src)[1]
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n${helmet}\n</head>\n<body>\n${render(body, vals)}\n</body>\n</html>\n`
  const name = file.replace(/\.html$/, '') + (suffix ? `.${suffix}` : '')
  writeFileSync(join(out, `${name}.html`), html)
  return name
}

const made = [
  page('app-command-center.html', null, 'store'),
  page('app-command-center.html', { mode: 'office' }, 'office'),
  page('app-agent-dashboard.html'),
  page('app-agent-library.html'),
  page('site-home.html', null, 'store'),
  page('site-home.html', { product: 'office' }, 'office'),
]
console.log(made.join('\n'))
