import type { CSSProperties } from 'react'
import { botSvg } from '../../deploi-app/lib/library/bot-svg'

/** The agent's drawn bot: the same drawing the app shows, from the same shared file. */
export function AgentCharacter({ agentKey, hue, shape, size = 'md', label }: { agentKey: string; hue: number; shape: 'round' | 'square'; size?: 'md' | 'lg'; label: string }) {
  return (
    <span className={`au-bot ${size === 'md' ? '' : size}`} style={{ '--au-h': hue } as CSSProperties} role="img" aria-label={label}
      data-bot={agentKey} dangerouslySetInnerHTML={{ __html: botSvg({ key: agentKey, hue, shape }) }} />
  )
}
