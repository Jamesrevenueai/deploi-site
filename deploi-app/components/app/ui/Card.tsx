import type { HTMLAttributes, ReactNode } from 'react'

type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li'; size?: 'md' | 'lg'; flush?: boolean; children: ReactNode }

/** A white card: 1px #ECECF2, radius 16 (lg: 18), 20px padding (flush: none). No accent border. */
export function Card({ as: Tag = 'div', size = 'md', flush = false, className, children, ...rest }: Props) {
  const c = ['app-card', size === 'lg' ? 'app-card--lg' : '', flush ? 'app-card--flush' : '', className ?? ''].filter(Boolean).join(' ')
  return <Tag className={c} {...rest}>{children}</Tag>
}
