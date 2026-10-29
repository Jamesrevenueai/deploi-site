import type { CSSProperties } from 'react'

/** The agent's bot character: its emoji in an aurora-lit blob tinted with its own hue (the same character the app shows). */
export function AgentCharacter({ emoji, hue, shape, size = 'md', label }: { emoji: string; hue: number; shape: 'round' | 'square'; size?: 'md' | 'lg'; label: string }) {
  return (
    <span className={`au-character ${shape} ${size}`} style={{ '--au-h': hue } as CSSProperties} role="img" aria-label={label}>
      <span aria-hidden="true">{emoji}</span>
    </span>
  )
}
