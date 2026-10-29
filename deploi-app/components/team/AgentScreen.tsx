'use client'
/**
 * One agent's dashboard (/store/team/<key>): its character, switch and permission level; chat by text
 * or voice; standing instructions; the approval queue with evidence and proof; the activity log; and
 * auto-run grants per action type. Custom agents (custom-<id>) get the queue and log only.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, useStore } from '@/components/store/bits'
import { Character } from './Character'
import { Switch } from './Switch'
import { useVoice } from './useVoice'
import { LEVEL_LABEL, LEVEL_SHORT, MODE_WORDS, STATUS_WORDS, TIER_NAME, fmtAgo, fmtWhen } from './format'
import type { ActionRow, AgentResponse, ChatMessage, ChatResponse, LogEntry, PermissionLevel } from './types'

type Tab = 'chat' | 'queue' | 'log' | 'instructions' | 'autorun'
const TABS: [Tab, string][] = [['chat', 'Chat'], ['queue', 'Approvals'], ['log', 'Activity'], ['instructions', 'Instructions'], ['autorun', 'Auto-run']]

export function AgentScreen({ agentKey }: { agentKey: string }) {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<AgentResponse>(`/api/store/library/${encodeURIComponent(agentKey)}`), agentKey)
  const [tab, setTab] = useState<Tab>(() => (typeof window !== 'undefined' && window.location.hash === '#queue' ? 'queue' : 'chat'))
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  const back = <Link href={`${base}/team`} className="mb-4 inline-flex items-center gap-1 text-[14px] text-grey hover:text-ink"><Icon name="arrow-right" size={14} style={{ transform: 'rotate(180deg)' }} />Your team</Link>
  if (loading && !data) return <>{back}<Loading label="Loading agent" rows={4} /></>
  if (error && !data) return <>{back}{error.status === 404 ? <Empty title="Agent not found">This agent is not in the library. <Link href={`${base}/team`} className="text-ink underline">Back to your team</Link></Empty> : <ErrorState error={error} onRetry={reload} />}</>
  if (!data) return null
  const a = data.agent
  const custom = agentKey.startsWith('custom-')

  const post = <T,>(action: string, body: unknown = {}) => storeFetch<T>(`/api/store/library/${encodeURIComponent(agentKey)}/${action}`, { method: 'POST', body })
  async function act(key: string, fn: () => Promise<string | null>) {
    setBusy(key); setNotice(null)
    try { const t = await fn(); if (t) setNotice({ tone: 'ok', text: t }) } catch (e) { const err = asApiError(e); setNotice({ tone: 'warn', text: err.code === 'upgrade_required' ? `${err.message}. See the plans.` : err.message }) } finally { setBusy(null); await reload() }
  }
  const flip = (on: boolean) => act('switch', async () => { await post('switch', { enabled: on }); return on ? `${a.name} is on. It runs once a day and whenever you ask.` : `${a.name} is off. Open drafts were closed.` })
  const runNow = () => act('run', async () => { const r = await post<{ status: string; reason?: string; counts: Record<string, number> }>('run'); const c = r.counts; return r.status === 'completed' ? `Run finished: ${c.noted} reported, ${c.drafted} waiting for you, ${c.done} done${c.failed ? `, ${c.failed} failed` : ''}${c.approvedUnsent ? `, ${c.approvedUnsent} approved but not sent (email is off here)` : ''}${c.skipped ? `, ${c.skipped} already open` : ''}.` : `Run ${r.status}: ${r.reason}. Nothing was changed.` })
  const setLevel = (level: PermissionLevel) => act('level', async () => { await post('permission', { level }); return `${a.name} is now at "${LEVEL_LABEL[level]}".${level !== 'act' ? ' Any auto-run grants were revoked.' : ' Grant auto-run per action type under the Auto-run tab.'}` })

  return (
    <>
      {back}
      <div className="au-panel glow p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <Character emoji={a.character.emoji} hue={a.character.hue} shape={a.character.shape} size="lg" off={!a.enabled} label={`${a.name} character`} />
            <div className="min-w-0">
              <span className="au-eyebrow">{custom ? 'Your own agent' : a.status === 'existing' ? 'Agent' : 'Agent · new'}</span>
              <h1 className="text-[1.6rem] leading-tight">{a.name}</h1>
              <p className="pt-1 text-[14px] text-grey">{a.tagline}</p>
            </div>
          </div>
          {!custom && (
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-3"><span className="text-[13px] text-grey-h">{a.enabled ? 'On' : 'Off'}</span>{a.locked ? <span className="au-lock"><Icon name="shield" size={12} />{a.upgradeTo ? `${TIER_NAME[a.upgradeTo]} · ` : ''}<Link href={`${base}/plan?upgrade=${a.upgradeTo ?? ''}`} className="underline">Upgrade</Link></span> : <Switch on={a.enabled} disabled={busy !== null || !data.store.connected} onChange={flip} label={`Switch ${a.name} ${a.enabled ? 'off' : 'on'}`} />}</div>
              <div className="au-level" role="group" aria-label="Permission level">{(['read', 'draft', 'act'] as PermissionLevel[]).map(l => <button key={l} type="button" aria-pressed={a.permission === l} disabled={a.locked || busy !== null} onClick={() => setLevel(l)} title={LEVEL_LABEL[l]}>{LEVEL_SHORT[l]}</button>)}</div>
            </div>
          )}
        </div>
        <p className="pt-4 text-[15px] text-grey">{a.description}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!custom && <Button size="xs" onClick={runNow} disabled={!a.enabled || busy !== null}><Icon name="bolt" size={13} />{busy === 'run' ? 'Running…' : 'Run now'}</Button>}
          <Badge tone="muted">{a.lastRunAt ? `last run ${fmtAgo(a.lastRunAt)} · ${a.lastRunStatus}` : 'not run yet'}</Badge>
          {a.waiting > 0 && <Badge tone="warn">{a.waiting} waiting for you</Badge>}
          {a.grants.length > 0 && <Badge tone="ok">{a.grants.length} auto-run grant{a.grants.length === 1 ? '' : 's'}</Badge>}
          {a.engineAgentId && <Link href={`${base}/agents/${a.engineAgentId}`} className="text-[13px] text-ink underline">Correction engine agent</Link>}
          {!data.store.synthetic && data.store.connected && <Badge tone="warn">Live store: library reads are not wired yet</Badge>}
        </div>
      </div>
      <div aria-live="polite">{notice && <div className="mt-4"><Banner tone={notice.tone === 'ok' ? 'info' : 'warn'} icon={notice.tone === 'ok' ? 'check' : 'alert'}>{notice.text}</Banner></div>}</div>

      <div className="au-tabs mt-6" role="tablist" aria-label="Agent sections">
        {TABS.filter(([k]) => !custom || k === 'queue' || k === 'log').map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className="au-tab" onClick={() => setTab(k)} id={`tab-${k}`}>{l}{k === 'queue' && a.waiting ? ` (${a.waiting})` : ''}</button>)}
      </div>
      <div role="tabpanel" aria-labelledby={`tab-${tab}`} className="mt-4">
        {tab === 'chat' && <ChatPanel agentKey={agentKey} name={a.name} history={data.chat} enabled={a.enabled} onChanged={reload} />}
        {tab === 'queue' && <QueuePanel queue={data.queue} agentKey={agentKey} onChanged={reload} />}
        {tab === 'log' && <LogPanel log={data.log} />}
        {tab === 'instructions' && <InstructionsPanel agent={a} agentKey={agentKey} onChanged={reload} />}
        {tab === 'autorun' && <AutoRunPanel agent={a} agentKey={agentKey} onChanged={reload} />}
      </div>
    </>
  )
}

function ChatPanel({ agentKey, name, history, enabled, onChanged }: { agentKey: string; name: string; history: ChatMessage[]; enabled: boolean; onChanged: () => Promise<void> }) {
  const [messages, setMessages] = useState<ChatMessage[]>(history)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setMessages(history) }, [history])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages.length])
  const voice = useVoice(t => { void send(t, 'voice') })

  async function send(t: string, via: 'text' | 'voice') {
    const body = t.trim()
    if (!body || sending) return
    setSending(true); setErr(null); setText('')
    try {
      const r = await storeFetch<ChatResponse>(`/api/store/library/${encodeURIComponent(agentKey)}/chat`, { method: 'POST', body: { text: body, via } })
      setMessages(m => [...m, r.merchant, r.agent])
      voice.speak(r.agent.text)
      if (r.agent.outcome.kind !== 'answer') await onChanged()
    } catch (e) { setErr(asApiError(e)) } finally { setSending(false) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void send(text, 'text') }
  return (
    <div className="au-panel p-4">
      <p className="mb-3 text-[13px] text-grey-h">Ask {name} what is waiting, say &ldquo;run now&rdquo;, or tell it &ldquo;from now on…&rdquo; to set a standing instruction. It answers from its own log and the store, never from a guess.{!enabled ? ' It is switched off, so it will not run.' : ''}</p>
      <div className="au-chat" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && <div className="au-bubble agent">Hello. I am {name}. Say &ldquo;help&rdquo; to see what I can do.</div>}
        {messages.map(m => <div key={m.id} className={`au-bubble ${m.role}`} data-role={m.role}>{m.text}{m.via === 'voice' && <span className="via">{m.role === 'merchant' ? 'spoken' : 'read aloud'}</span>}</div>)}
        <div ref={endRef} />
      </div>
      {err && <div className="mt-3"><Banner tone="warn"><strong>Not sent.</strong> {err.message}</Banner></div>}
      <form onSubmit={submit} className="mt-3 flex items-center gap-2">
        <button type="button" className={`au-mic ${voice.listening ? 'listening' : ''}`} onClick={() => (voice.listening ? voice.stop() : voice.start())} disabled={!voice.supported || sending} aria-label={voice.listening ? 'Stop listening' : voice.supported ? 'Speak to the agent' : 'Voice input is not available in this browser'} aria-pressed={voice.listening} title={voice.supported ? 'Speak' : 'Voice input needs a browser with speech recognition (Chrome, Edge, Safari)'}><Icon name="phone" size={18} /></button>
        <Input aria-label="Message" value={text} onChange={e => setText(e.target.value)} placeholder={voice.listening ? 'Listening…' : `Message ${name}`} disabled={sending} maxLength={4000} />
        <Button type="submit" size="sm" disabled={sending || !text.trim()}>{sending ? '…' : 'Send'}</Button>
      </form>
      <label className="mt-2 flex items-center gap-2 text-[12px] text-grey-h"><input type="checkbox" checked={voice.speakReplies} disabled={!voice.canSpeak} onChange={e => voice.setSpeakReplies(e.target.checked)} />Read replies aloud{!voice.canSpeak ? ' (not available in this browser)' : ''}</label>
    </div>
  )
}

function QueuePanel({ queue, agentKey, onChanged }: { queue: ActionRow[]; agentKey: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, string>>({})
  async function decide(id: string, decision: 'approve' | 'decline') {
    setBusy(id)
    try { const r = await storeFetch<{ status: string; executed?: boolean; reason?: string }>(`/api/store/library/actions/${id}/${decision}`, { method: 'POST', body: {} }); setResult(x => ({ ...x, [id]: decision === 'approve' ? (r.status === 'done' ? 'Done: a fresh read of the store shows the change.' : r.status === 'failed' ? `Failed: ${r.reason}` : 'Approved. Email sending is off in this environment, so nothing was sent; the text is ready to copy.') : 'Declined.' })) }
    catch (e) { setResult(x => ({ ...x, [id]: asApiError(e).message })) } finally { setBusy(null); await onChanged() }
  }
  if (!queue.length) return <Empty title="Nothing waiting for you">When {agentKey.startsWith('custom-') ? 'this agent' : 'the agent'} drafts something, it appears here with its evidence. Approving a change makes it and keeps a fresh read as proof.</Empty>
  return (
    <ul className="flex flex-col gap-3" id="queue" aria-label="Approval queue">
      {queue.map(q => (
        <li key={q.id} className="au-panel p-4" data-action={q.id} data-action-type={q.action_type}>
          <div className="flex flex-wrap items-center gap-2"><Badge tone="none">{STATUS_WORDS[q.status]?.label ?? q.status}</Badge><Badge tone="muted">{q.action_type.replace(/_/g, ' ')}</Badge><span className="text-ink font-medium">{q.title}</span></div>
          <p className="pt-2 text-[14px] text-grey">{q.summary}</p>
          <ActionDetail a={q} />
          <p className="pt-2 text-[12px] text-grey-h">Why it waits: {q.permission_basis}{q.expires_at ? ` · expires ${fmtWhen(q.expires_at)}` : ''}</p>
          {result[q.id] ? <p className="pt-2 text-[14px] text-ink">{result[q.id]}</p> : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="xs" onClick={() => decide(q.id, 'approve')} disabled={busy !== null} aria-label={`Approve: ${q.title}`}><Icon name="check" size={13} />{busy === q.id ? 'Working…' : 'Approve'}</Button>
              <Button size="xs" variant="ghost" onClick={() => decide(q.id, 'decline')} disabled={busy !== null} aria-label={`Decline: ${q.title}`}><Icon name="x" size={13} />Decline</Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function ActionDetail({ a }: { a: ActionRow }) {
  const p = a.payload
  const text = typeof p.body === 'string' ? p.body : typeof p.text === 'string' ? p.text : null
  return (
    <>
      {'from' in p && 'to' in p && <div className="au-draft"><span className="text-grey-h">{String(p.field ?? 'value')}: </span>{String(p.from) || '(empty)'} <Icon name="arrow-right" size={12} className="inline" /> {String(p.to)}</div>}
      {text && <div className="au-draft">{typeof p.subject === 'string' ? `Subject: ${p.subject}\n${typeof p.to === 'string' ? `To: ${p.to}\n` : ''}\n` : ''}{text}</div>}
      {typeof p.suggestedStep === 'string' && <p className="pt-2 text-[14px] text-ink"><span className="text-grey-h">Suggested step: </span>{p.suggestedStep}</p>}
      <details className="mt-2"><summary className="cursor-pointer text-[12px] text-ink">Evidence</summary><dl className="au-kv mt-2">{Object.entries(a.evidence).slice(0, 14).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v).slice(0, 240) : String(v)}</dd></div>)}</dl></details>
    </>
  )
}

function LogPanel({ log }: { log: LogEntry[] }) {
  if (!log.length) return <Empty title="No activity yet">Runs, switches, grants and every action with its proof appear here.</Empty>
  return (
    <div className="au-log" aria-label="Activity log">
      {log.map((e, i) => (
        <div key={i} className="au-log-row" data-kind={e.kind}>
          <div className="when">{fmtWhen(e.at)}</div>
          <div>
            <div className="flex flex-wrap items-center gap-2"><span className="text-ink">{e.what}</span><Badge tone={e.kind === 'action' ? (STATUS_WORDS[String(e.detail?.status)]?.tone ?? 'muted') : 'muted'}>{e.status}</Badge>{e.detail?.mode ? <Badge tone="muted">{MODE_WORDS[String(e.detail.mode)]}</Badge> : null}</div>
            <div className="pt-1 text-[12px] text-grey-h">Permission: {e.permission || '—'}{typeof e.detail?.status_reason === 'string' && e.detail.status_reason ? ` · ${e.detail.status_reason}` : ''}</div>
            {e.detail?.proof && typeof e.detail.proof === 'object' ? <div className="au-proof">Proof: {Object.entries(e.detail.proof as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : String(v)}`).join(' · ')}</div> : null}
            {e.kind === 'run' && e.detail?.counts ? <div className="pt-1 text-[12px] text-grey">{Object.entries(e.detail.counts as Record<string, number>).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(' · ') || 'nothing new'}{typeof e.detail.reason === 'string' && e.detail.reason ? ` · ${e.detail.reason}` : ''}</div> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function InstructionsPanel({ agent, agentKey, onChanged }: { agent: AgentResponse['agent']; agentKey: string; onChanged: () => Promise<void> }) {
  const [text, setText] = useState(agent.instructions)
  const [settings, setSettings] = useState<Record<string, string>>(Object.fromEntries(Object.entries(agent.settings).map(([k, v]) => [k, String(v)])))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fields = [...agent.needs, ...(agentKey === 'supplier_chaser' ? [] : []), ...(agentKey === 'inventory_watcher' || agentKey === 'store_health_checker' ? [{ key: 'notify', label: 'who receives the alerts (email)' }] : [])].filter((f, i, arr) => arr.findIndex(x => x.key === f.key) === i)
  async function save() {
    setBusy(true); setNote(null)
    try {
      await storeFetch(`/api/store/library/${agentKey}/instructions`, { method: 'POST', body: { text } })
      if (Object.keys(settings).length) await storeFetch(`/api/store/library/${agentKey}/settings`, { method: 'POST', body: { patch: settings } })
      setNote('Saved. The agent reads these on its next run.')
    } catch (e) { setNote(asApiError(e).message) } finally { setBusy(false); await onChanged() }
  }
  return (
    <div className="au-panel p-4">
      <Field label="Standing instructions" htmlFor="instructions" hint={<>Plain English, read on every run. Example: &ldquo;{agent.exampleTask}&rdquo;</>}>
        <Textarea id="instructions" rows={5} maxLength={4000} value={text} onChange={e => setText(e.target.value)} />
      </Field>
      {(fields.length > 0 || Object.keys(settings).length > 0) && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {[...fields.map(f => f.key), ...Object.keys(settings)].filter((k, i, a) => a.indexOf(k) === i).map(k => (
            <Field key={k} label={fields.find(f => f.key === k)?.label ?? k} htmlFor={`setting-${k}`}><Input id={`setting-${k}`} value={settings[k] ?? ''} onChange={e => setSettings({ ...settings, [k]: e.target.value })} /></Field>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3"><Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>{note && <span className="text-[13px] text-grey">{note}</span>}</div>
    </div>
  )
}

function AutoRunPanel({ agent, agentKey, onChanged }: { agent: AgentResponse['agent']; agentKey: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [caps, setCaps] = useState<Record<string, number>>({})
  async function grant(t: string) { setBusy(t); setNote(null); try { await storeFetch(`/api/store/library/${agentKey}/grant`, { method: 'POST', body: { actionType: t, maxPerDay: caps[t] ?? 20 } }); setNote(`Auto-run granted for "${agent.actionTypes.find(x => x.key === t)?.label}". It is logged, and you can revoke it at any time.`) } catch (e) { setNote(asApiError(e).message) } finally { setBusy(null); await onChanged() } }
  async function revoke(t: string) { setBusy(t); setNote(null); try { await storeFetch(`/api/store/library/${agentKey}/revoke`, { method: 'POST', body: { actionType: t } }); setNote('Revoked. From now on that action waits for your approval.') } catch (e) { setNote(asApiError(e).message) } finally { setBusy(null); await onChanged() } }
  return (
    <div className="au-panel p-4">
      <p className="text-[14px] text-grey">Auto-run lets the agent perform one action type on its own, up to a daily cap, and log each one with proof. It needs the agent at &ldquo;Act within limits&rdquo;{agent.permission !== 'act' ? ` (it is at "${LEVEL_LABEL[agent.permission]}" now)` : ''}. Money and publishing actions can never be granted: they always wait for you.</p>
      {note && <div className="mt-3"><Banner icon="check">{note}</Banner></div>}
      <ul className="mt-4 flex flex-col gap-2" aria-label="Action types">
        {agent.actionTypes.map(t => {
          const g = agent.grants.find(x => x.actionType === t.key)
          const approvalOnly = agent.approvalOnly.includes(t.key)
          return (
            <li key={t.key} className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line p-3" data-action-type={t.key}>
              <div><div className="text-ink text-[15px]">{t.label}</div><div className="text-[12px] text-grey-h">{!t.writes ? 'Reports only: no grant needed.' : approvalOnly ? 'Money or publishing: approval-only at every level.' : g ? `Auto-run on since ${fmtWhen(g.grantedAt)} · up to ${g.maxPerDay} a day` : 'Waits for your approval.'}</div></div>
              {t.writes && !approvalOnly && (g ? <Button size="xs" variant="ghost" onClick={() => revoke(t.key)} disabled={busy !== null}>Revoke</Button> : (
                <div className="flex items-center gap-2"><label className="text-[12px] text-grey-h" htmlFor={`cap-${t.key}`}>per day</label><input id={`cap-${t.key}`} type="number" min={1} max={500} className="input" style={{ width: 84, minHeight: 36, padding: '6px 10px' }} value={caps[t.key] ?? 20} onChange={e => setCaps({ ...caps, [t.key]: Number(e.target.value) })} /><Button size="xs" onClick={() => grant(t.key)} disabled={busy !== null || agent.permission !== 'act'}>Grant auto-run</Button></div>
              ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
