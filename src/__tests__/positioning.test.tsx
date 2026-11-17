import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LEGAL } from '../lib/brand'
import { MemoryRouter } from 'react-router-dom'

// legalReviewed is flipped per test through this mutable mock
const envMock = vi.hoisted(() => ({ env: { appApiUrl: '', formspreeEndpoint: '', appUrl: 'https://app.example.test' } }))
vi.mock('../lib/env', () => envMock)

import Home, { PILLARS, PRODUCTS, HOME_TITLE, HOME_DESCRIPTION } from '../pages/Home'
import Legal from '../pages/Legal'
import LegalIndex from '../pages/LegalIndex'
import Signup from '../pages/Signup'
import { Footer } from '../components/Footer'
import { CTA_HREF, CTA_LABEL } from '../components/Button'
import { CORE_MESSAGE } from '../lib/site-config'


describe('positioning', () => {
  it('leads with the core message and the three things Deploi does', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    expect(HOME_TITLE).toContain('Your business has unfinished work.')
    expect(HOME_DESCRIPTION).toContain(CORE_MESSAGE)
    expect(PILLARS.map(p => p.title)).toEqual(['Finds it', 'Handles it', 'Shows you what got done'])
    for (const p of PILLARS) expect(screen.getByRole('heading', { level: 3, name: p.title })).toBeInTheDocument()
    expect(PRODUCTS.map(p => p.name)).toEqual(['Deploi Office', 'Deploi Commerce'])
  })

  it('the call to action is the paid pilot application', () => {
    expect(CTA_LABEL).toBe('Apply for a paid pilot')
    expect(CTA_HREF).toBe('/#early-access')
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    expect(container.querySelector('#early-access form')).toHaveAccessibleName('Apply for a paid pilot')
    expect(container.textContent).toMatch(/you approve any charge/)
    expect(container.textContent).not.toMatch(/live now|generally available now/i)
  })

  it('signup sends people to the app', () => {
    render(<MemoryRouter><Signup /></MemoryRouter>)
    expect(screen.getByTestId('app-signin')).toHaveAttribute('href', 'https://app.example.test/login')
  })
})

describe('legal pages: no draft labels, the operator from one config value', () => {
  it('Terms, Privacy, the legal index and the footer show no DRAFT or pending-review label', () => {
    const { container } = render(<MemoryRouter><Footer /><Legal kind="terms" /><Legal kind="privacy" /><LegalIndex /></MemoryRouter>)
    expect(container.textContent).not.toMatch(/DRAFT|pending legal/)
    expect(screen.getAllByText('Terms of Service')[0]).toHaveAttribute('href', '/terms')
  })

  it('names the operator exactly, with the city only (no street address)', () => {
    expect(LEGAL).toEqual({ entity: 'James Investments and real estate holdings LLC', entityType: 'an Ohio limited liability company', location: 'Columbus, Ohio, USA' })
    for (const kind of ['terms', 'privacy'] as const) {
      const { container, unmount } = render(<MemoryRouter><Legal kind={kind} /></MemoryRouter>)
      expect(container.textContent).toContain('Deploi is operated by James Investments and real estate holdings LLC')
      expect(container.textContent).toContain('Columbus, Ohio, USA')
      expect(container.textContent).not.toMatch(/Deploi AI/)
      unmount()
    }
  })
})
