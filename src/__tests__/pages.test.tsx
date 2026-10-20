import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Nav, NAV_LINKS } from '../components/Nav'
import { Footer } from '../components/Footer'
import Legal, { termsSections } from '../pages/Legal'
import { FAQ, FAQS, MENU_ITEMS } from '../pages/Home'
import { CONTACT_EMAIL } from '../lib/brand'

describe('Nav', () => {
  it('renders the wordmark and every link', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>)
    expect(screen.getByLabelText('Deploi AI home')).toHaveTextContent('deploi ai')
    for (const l of NAV_LINKS) expect(screen.getAllByText(l.label).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument()
  })
})

describe('Footer', () => {
  it('links BAA and the company email under Support', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByText('Business Associate Agreement')).toHaveAttribute('href', '/baa')
    expect(screen.getByText(CONTACT_EMAIL)).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`)
    expect(screen.getByText(/All rights reserved/)).toBeInTheDocument()
  })
})

describe('Legal', () => {
  it('replaces the entity and contact placeholders', () => {
    const sections = termsSections('Example Holdings LLC')
    render(<MemoryRouter><ol>{sections.map(s => <li key={s.title}>{s.body}</li>)}</ol></MemoryRouter>)
    expect(screen.getByText('Example Holdings LLC')).toBeInTheDocument()
    expect(screen.queryByText(/\[LEGAL ENTITY NAME\]/)).toBeNull()
    expect(screen.queryByText(/\[CONTACT EMAIL\]/)).toBeNull()
    expect(screen.getAllByText(CONTACT_EMAIL).length).toBeGreaterThan(0)
  })
  it('defaults the entity to Deploi and shows the draft badge when unreviewed', () => {
    render(<MemoryRouter><Legal kind="terms" /></MemoryRouter>)
    expect(screen.getByText('Deploi AI', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/pending legal review/)).toBeInTheDocument()
  })
})

describe('Home content', () => {
  it('renders every FAQ question', () => {
    render(<MemoryRouter><FAQ /></MemoryRouter>)
    for (const f of FAQS) expect(screen.getByText(f.q)).toBeInTheDocument()
  })
  it('has eleven menu items and the home-care EVV page stays reachable from the footer', () => {
    expect(MENU_ITEMS).toHaveLength(11)
    expect(MENU_ITEMS.find(m => m.name === 'Claim exception layer')).toBeTruthy()
  })
})
