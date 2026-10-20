import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })
}

describe('lib/phi may only use the local Ollama lane', () => {
  it('never imports the cloud lane, the lane router, or a cloud SDK', () => {
    const files = walk(join(process.cwd(), 'lib/phi')).filter(f => /\.tsx?$/.test(f))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
      for (const imp of imports) {
        expect(imp, `${f} imports ${imp}`).not.toMatch(/llm\/cloud|llm\/index|llm['"]?$|openai|anthropic|resend|twilio/)
      }
      expect(src).not.toMatch(/api\.openai\.com|api\.anthropic\.com/)
    }
  })
})
