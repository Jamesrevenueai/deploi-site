import type { SVGProps } from 'react'

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export const Icon = {
  Clock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  ),
  Link: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
  ),
  Tag: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M20 13 13 20a2 2 0 0 1-3 0l-7-7V4h9l7 7a2 2 0 0 1 1 2z" /><circle cx="7.5" cy="7.5" r="1" /></svg>
  ),
  Users: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18 14a6 6 0 0 1 3.5 6" /></svg>
  ),
  Inbox: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>
  ),
  Shield: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
  ),
  Calendar: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
  ),
  Dollar: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M12 3v18" /><path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-2.5a3 3 0 0 0 0 6h3a3 3 0 0 1 0 6H11a3.5 3.5 0 0 1-3.5-2.5" /></svg>
  ),
  Chat: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} strokeWidth={2} {...p}><path d="M4 5h16v11H9l-5 4z" /></svg>
  ),
  Close: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} strokeWidth={2} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
  ),
  Chevron: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} strokeWidth={2} {...p}><polyline points="6 9 12 15 18 9" /></svg>
  ),
  Check: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} strokeWidth={2.5} {...p}><polyline points="5 12 10 17 19 8" /></svg>
  ),
  LinkedIn: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 10v7M8 7v.5M12 17v-4a2 2 0 0 1 4 0v4M12 10v7" /></svg>
  ),
  YouTube: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><rect x="2.5" y="5.5" width="19" height="13" rx="4" /><path d="m10 9 5 3-5 3z" /></svg>
  ),
  X: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M4 4l16 16M20 4 4 20" /></svg>
  ),
}
