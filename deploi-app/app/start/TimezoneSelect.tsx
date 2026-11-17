'use client'
import { useEffect, useState } from 'react'
import { Select } from '@/components/ui/Field'

const ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney']

/** The browser's own time zone, preselected; the full list where the browser offers it. */
export function TimezoneSelect({ id, name }: { id: string; name: string }) {
  const [zones, setZones] = useState(ZONES)
  const [tz, setTz] = useState('UTC')
  useEffect(() => {
    try {
      const mine = Intl.DateTimeFormat().resolvedOptions().timeZone
      const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
      const all = f ? f('timeZone') : ZONES
      setZones(all.includes(mine) ? all : [mine, ...all]); if (mine) setTz(mine)
    } catch { /* the short list */ }
  }, [])
  return <Select id={id} name={name} value={tz} onChange={e => setTz(e.target.value)}>{zones.map(z => <option key={z} value={z}>{z}</option>)}</Select>
}
