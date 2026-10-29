import type { CSSProperties } from 'react'

/** The agent's bot character: its emoji in an aurora-lit blob tinted with its own hue. */
export function Character({ emoji, hue, shape, size = 'md', off = false, label }: { emoji: string; hue: number; shape: 'round' | 'square'; size?: 'sm' | 'md' | 'lg'; off?: boolean; label?: string }) {
  return (
    <span className={`au-character ${shape} ${size === 'md' ? '' : size} ${off ? 'off' : ''}`} style={{ '--au-h': hue } as CSSProperties} role="img" aria-label={label ?? 'agent character'}>
      <span aria-hidden="true">{emoji}</span>
    </span>
  )
}
