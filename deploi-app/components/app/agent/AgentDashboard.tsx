'use client'
/**
 * The agent dashboard (/agents/:id): header with pause/resume and "Call this agent", four stats, the chat, its
 * tasks you gave it, its autonomy level, standing instructions, what it can touch, and its work with proof. All real data: the server
 * page passes the first dashboard and chat history; every change goes through /api/app (or the pause action).
 */
import { useRef, useState } from 'react'
import type { AgentAutonomy, AgentDashboard as Dashboard, ChatMessage } from '@/lib/app/contract'
import { BotAvatar } from '@/components/app/BotAvatar'
import { agentApi } from './api'
import { setAgentPaused, type PauseResult } from './actions'
import { Button, MicIcon, StatusPill } from './bits'
import { AutonomyCard } from './AutonomyCard'
import { InstructionsCard } from './InstructionsCard'
import { TasksCard } from './TasksCard'
import { ChatPanel, type ChatHandle } from './ChatPanel'
import { ScopesCard, StatCards, WorkTable } from './Panels'

export function AgentDashboard({ initial, history, pause = setAgentPaused }: { initial: Dashboard; history: ChatMessage[]; pause?: (id: string, paused: boolean) => Promise<PauseResult> }) {
  const [d, setD] = useState<Dashboard>(initial)
  const [pausing, setPausing] = useState(false)
  const [pauseError, setPauseError] = useState<string | null>(null)
  const chat = useRef<ChatHandle>(null)
  const { agent } = d
  const id = agent.id
  const off = agent.status === 'off'

  const refresh = async () => { try { setD(await agentApi.dashboard(id)) } catch { /* keep what is shown; the next change refreshes */ } }

  async function togglePause() {
    setPausing(true); setPauseError(null)
    try {
      const r = await pause(id, !off)
      if (r.ok) setD(r.dashboard); else setPauseError(r.message)
    } catch { setPauseError('Something went wrong; nothing was changed.') } finally { setPausing(false) }
  }
  async function saveAutonomy(v: AgentAutonomy) {
    await agentApi.setAutonomy(id, v)
    await refresh()
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1392px] flex-col gap-5 text-[#2A2A3A]">
      <a href="/store" data-back="command-center" className="inline-flex min-h-[44px] w-fit items-center gap-1 text-[14px] font-semibold text-[#14141F] no-underline hover:underline focus-visible:outline-2 focus-visible:outline-[#2333A8]">
        <span aria-hidden="true">‹</span> Command center
      </a>

      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_420px] items-center gap-4">
          <BotAvatar color={agent.color} size={84} smile />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="app-h1">{agent.name}</h1>
              <StatusPill status={agent.status} />
            </div>
            <p className="m-0 mt-1 text-[15px] text-[#5C5C70]">{agent.job}</p>
            <p className="m-0 mt-1 text-[13px] text-[#5C5C70]" data-testid="doing-now">{agent.doingNow}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void togglePause()} disabled={pausing}>{pausing ? (off ? 'Resuming…' : 'Pausing…') : off ? 'Resume agent' : 'Pause agent'}</Button>
          <Button variant="primary" onClick={() => chat.current?.call()}><MicIcon /> Call this agent</Button>
        </div>
      </header>
      {pauseError && <p role="alert" className="m-0 text-[13px] font-semibold text-[#B42318]">{pauseError}</p>}

      <StatCards stats={d.stats} />

      <div className="grid min-w-0 items-start gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))' }}>
        <ChatPanel ref={chat} agent={agent} history={history}
          ops={{ send: async t => { const m = await agentApi.chat(id, t); void refresh(); return m }, decide: async a => { await agentApi.decide(a.needsYouId, a.decision); void refresh() } }} />
        <div className="flex min-w-0 flex-col gap-5">
          <TasksCard agentName={agent.name} tasks={d.tasks ?? []}
            ops={{ give: async t => { const r = await agentApi.giveTask(id, t); await refresh(); return r }, finish: async (ref, op) => { await agentApi.finishTask(ref, op); await refresh() } }} />
          <AutonomyCard agentName={agent.name} value={agent.autonomy} chosen={agent.autonomyChosen} onSave={saveAutonomy} />
          <InstructionsCard agentName={agent.name} initial={d.instructions}
            ops={{ add: t => agentApi.addInstruction(id, t), update: (iid, t) => agentApi.updateInstruction(id, iid, t), remove: async iid => { await agentApi.deleteInstruction(id, iid) } }} />
          <ScopesCard scopes={d.scopes} />
        </div>
      </div>

      <WorkTable rows={d.work} />
    </div>
  )
}
