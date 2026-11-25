import Link from 'next/link'
import type { AgentScope, AgentStat, WorkRow } from '@/lib/app/contract'
import { css } from '@/components/dp/css'
import { H2 } from '@/components/dp/bits'
import { formatStat, formatWhen } from './bits'

/** Four stat cards (design-ref/app-agent-dashboard.html), from the dashboard's agent-specific stats. */
export function StatCards({ stats }: { stats: AgentStat[] }) {
  return (
    <section aria-label="Agent numbers" style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px;')}>
      {stats.slice(0, 4).map(s => (
        <div key={s.key} data-testid="agent-stat" style={css('border: 1px solid #E0E7FF; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 6px;')}>
          <span style={css('font-size: 13px; font-weight: 600; color: #4F46E5;')}>{s.label}</span>
          <span style={css('font-size: 28px; font-weight: 800; color: #1E1B4B;')}>{formatStat(s.value, s.unit)}</span>
        </div>
      ))}
    </section>
  )
}

const ON = 'font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #4F46E5; color: #FFFFFF; white-space: nowrap;'
const ASKS = 'font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #EEF2FF; color: #3730A3; white-space: nowrap;'
const OFF = 'font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #FFFFFF; border: 1px solid #C7D2FE; color: #3730A3; white-space: nowrap;'

/** The design's three states, from the real level: reading (or acting) = On; drafts and ask-first wait for you = Asks first; a write it may not do = Off. */
export function permissionOf(s: AgentScope): 'On' | 'Asks first' | 'Off' {
  if (s.level === 'act') return 'On'
  if (s.level === 'ask' || s.level === 'draft') return 'Asks first'
  return /^(read|see|view|watch)\b/i.test(s.label) ? 'On' : 'Off'
}

/** "What it's allowed to do": one row per real scope with On / Asks first / Off. */
export function ScopesCard({ scopes }: { scopes: AgentScope[] }) {
  return (
    <section aria-labelledby="perm-h" style={css('border: 1px solid #E0E7FF; border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px;')}>
      <h2 id="perm-h" style={css(H2)}>What it&apos;s allowed to do</h2>
      {scopes.length === 0 ? <p style={css('margin: 0; font-size: 14px; color: #3730A3;')}>Nothing yet: it can touch nothing until you connect a system and switch it on.</p> : (
        <ul style={css('margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column;')} data-testid="permissions">
          {scopes.map(s => {
            const p = permissionOf(s)
            return (
              <li key={`${s.label}-${s.level}`} data-level={s.level} style={css('display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 40px; font-size: 14px; color: #1E1B4B;')}>
                <span>{s.label}</span><span style={css(p === 'On' ? ON : p === 'Asks first' ? ASKS : OFF)}>{p}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** "Work log — every action, with proof": When / What it did / Result / Proof. Scrolls sideways in its own box on a phone. */
export function WorkTable({ rows }: { rows: WorkRow[] }) {
  return (
    <section aria-labelledby="log-h" style={css('border: 1px solid #E0E7FF; border-radius: 18px; overflow: hidden;')}>
      <div style={css('padding: 16px 20px; border-bottom: 1px solid #E0E7FF;')}><h2 id="log-h" style={css(H2)}>Work log — every action, with proof</h2></div>
      {rows.length === 0 ? <p style={css('margin: 0; padding: 18px 20px; font-size: 14px; color: #3730A3;')}>No work yet. Finished work shows here with its proof.</p> : (
        <div style={css('overflow-x: auto;')} role="region" aria-label="Work log (scrolls sideways on small screens)" tabIndex={0}>
          <table style={css('width: 100%; border-collapse: collapse; font-size: 14px; min-width: 640px;')} data-testid="work-log">
            <thead><tr style={css('text-align: left; color: #4F46E5; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;')}>
              {['When', 'What it did', 'Result', 'Proof'].map(h => <th key={h} scope="col" style={css('padding: 12px 20px; font-weight: 700;')}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.slice(0, 10).map((r, i) => (
                <tr key={`${r.when}-${i}`} style={css('border-top: 1px solid #EEF2FF;')}>
                  <td style={css("padding: 14px 20px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #4F46E5; white-space: nowrap;")}><time dateTime={r.when} suppressHydrationWarning>{formatWhen(r.when)}</time></td>
                  <td style={css('padding: 14px 20px; color: #1E1B4B;')}>{r.what}</td>
                  <td style={css('padding: 14px 20px; color: #3730A3;')}>{r.result}</td>
                  <td style={css('padding: 14px 20px;')}>{r.proof ? <Link href={r.proof.href} data-testid="proof-link" style={css('font-weight: 700; text-decoration: none; color: #4F46E5;')}>{r.proof.label}</Link> : <span style={css('color: #3730A3;')}>Being recorded</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 10 && <p style={css('margin: 0; padding: 14px 20px; border-top: 1px solid #EEF2FF; font-size: 13px;')}><Link href="/store/completed" style={css('font-weight: 700; text-decoration: none; color: #4F46E5;')}>All {rows.length} entries in the proof log →</Link></p>}
        </div>
      )}
    </section>
  )
}
