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
  Search: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
  ),
  Doc: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>
  ),
  Pencil: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
  ),
  UserCheck: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="m16 11 2 2 4-4" /></svg>
  ),
  Refresh: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 21v-5h-5" /></svg>
  ),
  Lock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></svg>
  ),
  History: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></svg>
  ),
  Store: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M4 9.5V20h16V9.5" /><path d="M3 4h18l-1.5 5.5a2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.9 0 2.5 2.5 0 0 1-4.9 0 2.5 2.5 0 0 1-4.4 0z" /><path d="M10 20v-5h4v5" /></svg>
  ),
  Alert: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17v.5" /></svg>
  ),
  Link: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
  ),
  Shield: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
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
}
