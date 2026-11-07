/** The Deploi agent avatar. Decorative: always aria-hidden; the agent's name is shown next to it. */
export function BotAvatar({ color, size = 40, smile = false }: { color: string; size?: number; smile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      <line x1="20" y1="3" x2="20" y2="9" stroke="#14141F" strokeWidth="2" />
      <circle cx="20" cy="3" r="2.5" fill={color} />
      <rect x="4" y="9" width="32" height="27" rx="10" fill={color} />
      <rect x="9" y="15" width="22" height="13" rx="6" fill="#FFFFFF" />
      <circle cx="15" cy="21.5" r="2.4" fill="#14141F" />
      <circle cx="25" cy="21.5" r="2.4" fill="#14141F" />
      {smile && <path d="M16 25.5q4 2 8 0" stroke="#14141F" strokeWidth="1.6" fill="none" strokeLinecap="round" />}
    </svg>
  )
}
