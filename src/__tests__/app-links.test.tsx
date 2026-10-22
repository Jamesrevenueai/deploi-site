import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Nav } from '../components/Nav'
import { appLinks, DEFAULT_APP_URL } from '../lib/env'

describe('app links', () => {
  it('defaults to app.getdeploi.com', () => {
    expect(DEFAULT_APP_URL).toBe('https://app.getdeploi.com')
    expect(appLinks('')).toEqual({ signIn: 'https://app.getdeploi.com/login', getStarted: 'https://app.getdeploi.com/signup' })
  })
  it('honours a configured base and strips trailing slashes', () => {
    expect(appLinks('https://preview.example.com//')).toEqual({
      signIn: 'https://preview.example.com/login',
      getStarted: 'https://preview.example.com/signup',
    })
  })
  it('renders Sign in and Get started in the nav pointing at the app', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>)
    const signIn = screen.getAllByRole('link', { name: 'Sign in' })
    const start = screen.getAllByRole('link', { name: 'Get started' })
    expect(signIn.length).toBeGreaterThan(0)
    expect(start.length).toBeGreaterThan(0)
    for (const a of signIn) expect(a).toHaveAttribute('href', appLinks().signIn)
    for (const a of start) expect(a).toHaveAttribute('href', appLinks().getStarted)
    expect(start[0].className).toMatch(/btn-primary/)
    expect(signIn[0].className).toMatch(/btn-ghost/)
  })
})
