'use client'
/**
 * The agent dashboard (/agents/:id), ported from the approved design (design-ref/app-agent-dashboard.html): the #F5F7FF
 * hero (bot, name, status pill, what it does, its own mailbox and connected tools, Pause/Resume, Run a check now), four
 * stats, "Talk to <agent>" (text or voice, history kept), standing instructions, what it's allowed to do, and the work log
 * with a proof link on every row. Below the design's sections: tasks you gave it and its autonomy level (both real).
 * All data is the server's; every change goes through /api/app (or the pause action).
 */
import { useRef, useState } from 'react'
import Link from 'next/link'
import type { AgentAutonomy, AgentDashboard as Dashboard, ChatMessage } from '@/lib/app/contract'
import { css } from '@/components/dp/css'
import { BotHero, PILL, BTN_PRIMARY, BTN_SECONDARY } from '@/components/dp/bits'
import { agentApi } from './api'
import { setAgentPaused, type PauseResult } from './actions'
import { AutonomyCard } from './AutonomyCard'
import { InstructionsCard } from './InstructionsCard'
import { TasksCard } from './TasksCard'
import { ChatPanel, type ChatHandle } from './ChatPanel'
import { ScopesCard, StatCards, WorkTable } from './Panels'

export function AgentDashboard({ initial, history, tools = [], pause = setAgentPaused }: { initial: Dashboard; history: ChatMessage[]; tools?: string[]; pause?: (id: string, paused: boolean) => Promise<PauseResult> }) {
  const [d, setD] = useState<Dashboard>(initial)
  const [pausing, setPausing] = useState(false)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const chat = useRef<ChatHandle>(null)
  const { agent } = d
  const id = agent.id
  const off = agent.status === 'off'
  const pill = off ? 'Paused' : agent.status === 'waiting' ? 'Needs you' : agent.status === 'working' ? 'Working' : 'Idle'
  const line = [d.mailbox, ...tools].filter(Boolean).join(' · ')

  const refresh = async () => { try { setD(await agentApi.dashboard(id)) } catch { /* keep what is shown; the next change refreshes */ } }

  async function togglePause() {
    setPausing(true); setMessage(null)
    try {
      const r = await pause(id, !off)
      if (r.ok) setD(r.dashboard); else setMessage({ tone: 'error', text: r.message })
    } catch { setMessage({ tone: 'error', text: 'Something went wrong; nothing was changed.' }) } finally { setPausing(false) }
  }
  async function runNow() {
    setRunning(true); setMessage(null)
    try { const r = await agentApi.runCheck(id); setMessage({ tone: 'ok', text: r.summary }); await refresh() } catch (e) { setMessage({ tone: 'error', text: (e as Error).message }) } finally { setRunning(false) }
  }
  async function saveAutonomy(v: AgentAutonomy) {
    await agentApi.setAutonomy(id, v)
    await refresh()
  }

  return (
    <div style={css('display: flex; flex-direction: column; gap: 24px; min-width: 0;')} data-testid="agent-dashboard">
      <Link href="/store/my-team" data-back="all-agents" style={css('font-size: 13px; font-weight: 700; text-decoration: none; color: #4F46E5; min-height: 24px;')}>← All agents</Link>

      <section style={css('border: 1px solid #E0E7FF; border-radius: 20px; background: #F5F7FF; padding: 28px; display: flex; flex-wrap: wrap; gap: 24px; align-items: center;')}>
        <BotHero label={`${agent.name} bot`} />
        <div style={css('flex: 1 1 320px; display: flex; flex-direction: column; gap: 8px; min-width: 0;')}>
          <div style={css('display: flex; flex-wrap: wrap; align-items: center; gap: 10px;')}>
            <h1 style={css('margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.025em; color: #1E1B4B;')}>{agent.name}</h1>
            <span style={css(PILL[pill])} data-testid="agent-status">{pill}</span>
          </div>
          <p style={css('margin: 0; font-size: 15px; line-height: 1.55; color: #3730A3; max-width: 560px;')}>{agent.job}</p>
          <p style={css('margin: 0; font-size: 13px; color: #312E81;')} data-testid="doing-now">{agent.doingNow}</p>
          {line && <span style={css("font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #4F46E5; word-break: break-all;")} data-testid="agent-tools">{line}</span>}
        </div>
        <div style={css('display: flex; flex-wrap: wrap; gap: 10px;')}>
          <button className="dp-btn" type="button" onClick={() => void togglePause()} disabled={pausing} style={css(BTN_SECONDARY)}>{pausing ? (off ? 'Resuming…' : 'Pausing…') : off ? 'Resume agent' : 'Pause agent'}</button>
          <button className="dp-btn" type="button" onClick={() => void runNow()} disabled={running || off} style={css(BTN_PRIMARY)}>{running ? 'Checking…' : 'Run a check now'}</button>
        </div>
      </section>
      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} style={css(`margin: 0; font-size: 13px; font-weight: 600; color: ${message.tone === 'error' ? '#B42318' : '#047857'};`)}>{message.text}</p>}

      <StatCards stats={d.stats} />

      <div style={css('display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start;')}>
        <ChatPanel ref={chat} agent={agent} history={history}
          ops={{ send: async (t, via) => { const m = await agentApi.chat(id, t, via); void refresh(); return m }, decide: async a => { await agentApi.decide(a.needsYouId, a.decision); void refresh() } }} />
        <div style={css('flex: 1 1 360px; min-width: 0; display: flex; flex-direction: column; gap: 20px;')}>
          <InstructionsCard agentName={agent.name} initial={d.instructions}
            ops={{ add: t => agentApi.addInstruction(id, t), update: (iid, t) => agentApi.updateInstruction(id, iid, t), remove: async iid => { await agentApi.deleteInstruction(id, iid) } }} />
          <ScopesCard scopes={d.scopes} />
        </div>
      </div>

      <WorkTable rows={d.work} />

      <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 20px; align-items: start;')}>
        <TasksCard agentName={agent.name} tasks={d.tasks ?? []}
          ops={{ give: async t => { const r = await agentApi.giveTask(id, t); await refresh(); return r }, finish: async (ref, op) => { await agentApi.finishTask(ref, op); await refresh() } }} />
        <AutonomyCard agentName={agent.name} value={agent.autonomy} chosen={agent.autonomyChosen} onSave={saveAutonomy} />
      </div>
    </div>
  )
}
