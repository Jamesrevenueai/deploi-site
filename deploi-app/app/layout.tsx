import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-inter', display: 'swap' })

export const metadata: Metadata = {
  title: { default: 'Deploi', template: '%s · Deploi' },
  description: 'Deploi operating system',
  robots: { index: false, follow: false },
}
export const viewport: Viewport = { themeColor: '#000000', width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  )
}
