import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LEGAL } from '../lib/brand'
import { MemoryRouter } from 'react-router-dom'

// legalReviewed is flipped per test through this mutable mock
const envMock = vi.hoisted(() => ({ env: { appApiUrl: '', formspreeEndpoint: '', appUrl: 'https://app.example.test' } }))
vi.mock('../lib/env', () => envMock)

import Home, { HOME_TITLE, HOME_DESCRIPTION } from '../pages/Home'
import Legal from '../pages/Legal'
import LegalIndex from '../pages/LegalIndex'
import Signup from '../pages/Signup'
import { Footer } from '../components/Footer'
import { CTA_HREF, CTA_LABEL } from '../components/Button'


describe('positioning', () => {
  it('leads with the approved headline: a team of AI agents for your store, and the office too', () => {
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    expect(HOME_TITLE).toBe('Deploi — AI agents that run your store and your office')
    expect(HOME_DESCRIPTION).toMatch(/receipt for every action/)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your store,run by a teamof AI agents.')
    expect(container.textContent).not.toMatch(/live now|generally available now/i)
    expect(container.textContent).not.toMatch(/Deploi AI/)
  })

  it('the pilot application lives on the sign-up page', () => {
    expect(CTA_LABEL).toBe('Apply for a paid pilot')
    expect(CTA_HREF).toBe('/signup#early-access')
    const { container } = render(<MemoryRouter><Signup /></MemoryRouter>)
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
    expect(screen.getAllByRole('link', { name: 'Terms' })[0]).toHaveAttribute('href', '/terms')
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
