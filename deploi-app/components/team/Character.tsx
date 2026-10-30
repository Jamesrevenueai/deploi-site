import type { CSSProperties } from 'react'
import { botSvg } from '@/lib/library/bot-svg'

/** The agent's drawn bot: one body plan, tinted with the agent's hue, with its own head shape and chest emblem. */
export function Character({ agentKey, hue, shape, size = 'md', off = false, label }: { agentKey: string; hue: number; shape: 'round' | 'square'; size?: 'sm' | 'md' | 'lg'; off?: boolean; label?: string }) {
  return (
    <span className={`au-bot ${size === 'md' ? '' : size} ${off ? 'off' : ''}`} style={{ '--au-h': hue } as CSSProperties} role="img" aria-label={label ?? 'agent character'}
      data-bot={agentKey} dangerouslySetInnerHTML={{ __html: botSvg({ key: agentKey, hue, shape }) }} />
  )
}
