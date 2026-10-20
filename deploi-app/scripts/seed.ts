/**
 * Idempotent seed: one fake agency (Buckeye Home Care, Columbus OH) with
 * 12 aides, 40 clients, 300 visits / 30 days, 6 open shifts, 9 EVV exceptions,
 * 3 referrals in flight, 5 applicants, plus a pipeline of prospects for staff.
 * A second, tiny "RLS control" agency exists only so the tenancy test has a
 * neighbour to be unable to read. All names are synthetic. Every row has a
 * deterministic id so `npm run seed` can run any number of times.
 */
import 'dotenv/config'
import { Client } from 'pg'
import { uuidFrom } from '../lib/ids'

const FIRST = ['Avery','Jordan','Riley','Morgan','Casey','Taylor','Quinn','Reese','Harper','Rowan','Emerson','Finley','Dakota','Skyler','Hayden','Parker','Sawyer','Blake','Elliot','Marlowe','Tatum','Kendall','Sloane','Arden','Lennox','Monroe','Oakley','Remy','Shiloh','Wren']
const LAST = ['Okafor','Lindqvist','Baptiste','Marchetti','Nakamura','Delgado','Whitaker','Oyelaran','Castellanos','Petrov','Haddad','Brennan','Kowalski','Mbeki','Sorensen','Vance','Abernathy','Ferreira','Lachance','Thornbury']
const COUNTIES = ['Franklin','Delaware','Licking','Fairfield','Pickaway','Madison','Union']
const PROGRAMS = ['PASSPORT','OHCW','MyCare','DODD','private-pay']

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const r = rng(20261020)
const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)]
const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
const dayOffset = (days: number, hour = 9, minute = 0) => { const d = new Date(); d.setHours(hour, minute, 0, 0); d.setDate(d.getDate() + days); return d }
const iso = (d: Date) => d.toISOString()
const ymd = (d: Date) => d.toISOString().slice(0, 10)

type Row = Record<string, unknown>
async function upsert(c: Client, table: string, rows: Row[], conflict = 'id') {
  if (!rows.length) return 0
  const cols = Object.keys(rows[0])
  for (const row of rows) {
    const vals = cols.map(k => row[k])
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
    const updates = cols.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(',')
    await c.query(`insert into ${table} (${cols.join(',')}) values (${placeholders}) on conflict (${conflict}) do update set ${updates}`, vals)
  }
  return rows.length
}

export async function seed(databaseUrl = process.env.DATABASE_URL, opts: { client?: Client } = {}) {
  if (!databaseUrl && !opts.client) throw new Error('DATABASE_URL required')
  const c = opts.client ?? new Client({ connectionString: databaseUrl, ssl: databaseUrl!.includes('supabase.co') ? { rejectUnauthorized: false } : undefined })
  await c.connect()
  const counts: Record<string, number> = {}

  // ---------------------------------------------------------------- agencies
  const A = uuidFrom('agency:buckeye')
  const B = uuidFrom('agency:scioto')
  counts.agencies = await upsert(c, 'agencies', [
    { id: A, name: 'Buckeye Home Care', city: 'Columbus', county: 'Franklin', state: 'OH', timezone: 'America/New_York',
      capacity_rules: JSON.stringify({ counties: ['Franklin','Delaware','Licking','Fairfield'], services: ['T1019','S5125','G0156','T2025'], hours: { start: '07:00', end: '20:00' }, max_new_clients_per_week: 4 }),
      radius_miles: 25, interview_slots: JSON.stringify([{ weekday: 2, time: '10:00' }, { weekday: 4, time: '14:00' }]),
      auto_send: JSON.stringify({}), assessment_credit_cents: 0, assessment_credit_expires_at: null, prospect_id: uuidFrom('prospect:buckeye') },
    { id: B, name: 'Scioto Valley Home Care (RLS control)', city: 'Chillicothe', county: 'Ross', state: 'OH', timezone: 'America/New_York',
      capacity_rules: JSON.stringify({ counties: ['Ross'], services: ['T1019'], hours: { start: '08:00', end: '18:00' } }),
      radius_miles: 20, interview_slots: '[]', auto_send: '{}', assessment_credit_cents: 0, assessment_credit_expires_at: null, prospect_id: null },
  ])

  // ---------------------------------------------------------------- users + profiles
  const users = [
    { key: 'user:hello', email: 'hello@getdeploi.com', full_name: 'Deploi Staff', role: 'staff', agency_id: null },
    { key: 'user:ojae', email: 'ojae@getdeploi.com', full_name: 'Ojae', role: 'staff', agency_id: null },
    { key: 'user:buckeye-admin', email: 'admin@buckeyehomecare.example', full_name: 'Dana Whitaker', role: 'client', agency_id: A },
    { key: 'user:scioto-admin', email: 'admin@sciotovalley.example', full_name: 'Lee Brennan', role: 'client', agency_id: B },
  ]
  const hasSupabaseAdmin = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  for (const u of users) {
    let id: string | null = (await c.query('select id from auth.users where lower(email) = lower($1)', [u.email])).rows[0]?.id ?? null
    if (!id) {
      if (hasSupabaseAdmin) {
        const { createClient } = await import('@supabase/supabase-js')
        const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
        const { data, error } = await sb.auth.admin.createUser({ email: u.email, email_confirm: true, user_metadata: { full_name: u.full_name } })
        if (error) throw error
        id = data.user.id
      } else {
        id = uuidFrom(u.key)
        await c.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [id, u.email])
      }
    }
    await c.query(
      `insert into profiles (id, email, full_name, role, agency_id) values ($1,$2,$3,$4,$5)
       on conflict (id) do update set email = excluded.email, full_name = excluded.full_name, role = excluded.role, agency_id = excluded.agency_id`,
      [id, u.email, u.full_name, u.role, u.agency_id])
  }
  counts.profiles = users.length

  // ---------------------------------------------------------------- aides (12)
  const aides: Row[] = []
  for (let i = 0; i < 12; i++) {
    const creds = [
      { type: 'STNA', expires_on: ymd(dayOffset(i < 3 ? int(5, 28) : int(45, 400))) },
      { type: 'CPR', expires_on: ymd(dayOffset(i === 4 ? 12 : int(60, 700))) },
      { type: 'BCI', expires_on: ymd(dayOffset(int(90, 1000))) },
    ]
    aides.push({
      id: uuidFrom(`aide:${i}`), agency_id: A, first_name: FIRST[i], last_name: LAST[i], phone: `+1614555${String(1000 + i).padStart(4, '0')}`,
      email: `${FIRST[i].toLowerCase()}.${LAST[i].toLowerCase()}@example.com`, credentials: JSON.stringify(creds),
      services: i % 4 === 3 ? ['T1019', 'T2025'] : ['T1019', 'S5125', 'G0156'], hired_on: ymd(dayOffset(-int(10, 900))),
      lat: 39.96 + (r() - 0.5) * 0.3, lng: -83.0 + (r() - 0.5) * 0.3, active: true, declined_client_ids: '{}',
    })
  }
  counts.aides = await upsert(c, 'aides', aides)

  // ---------------------------------------------------------------- clients (40)
  const clients: Row[] = []
  for (let i = 0; i < 40; i++) {
    const program = PROGRAMS[i % 5]
    clients.push({
      id: uuidFrom(`client:${i}`), agency_id: A, first_name: FIRST[(i * 7) % FIRST.length], last_name: LAST[(i * 3) % LAST.length],
      program, county: i < 28 ? 'Franklin' : pick(COUNTIES), service_codes: program === 'DODD' ? ['T2025'] : ['T1019', 'S5125'],
      lat: 39.96 + (r() - 0.5) * 0.4, lng: -83.0 + (r() - 0.5) * 0.4, active: true,
    })
  }
  counts.clients = await upsert(c, 'clients', clients)

  // ---------------------------------------------------------------- authorizations (40)
  const auths: Row[] = []
  for (let i = 0; i < 40; i++) {
    const authorized = int(400, 1200)
    let used = int(100, Math.floor(authorized * 0.8))
    if (i < 6) used = Math.floor(authorized * (0.86 + r() * 0.1)) // <= 15% left
    const ends = i >= 6 && i < 10 ? dayOffset(int(5, 29)) : dayOffset(int(40, 200))
    auths.push({ id: uuidFrom(`auth:${i}`), agency_id: A, client_id: uuidFrom(`client:${i}`), service_code: (clients[i].service_codes as string[])[0],
      units_authorized: authorized, units_used: used, starts_on: ymd(dayOffset(-int(60, 180))), ends_on: ymd(ends) })
  }
  counts.authorizations = await upsert(c, 'authorizations', auths)

  // ---------------------------------------------------------------- shifts
  const shifts: Row[] = []
  // 6 open shifts in the next 3 days
  for (let i = 0; i < 6; i++) {
    const start = dayOffset(int(0, 3), int(7, 15))
    const end = new Date(start.getTime() + int(2, 4) * 3600e3)
    shifts.push({ id: uuidFrom(`shift:open:${i}`), agency_id: A, client_id: uuidFrom(`client:${i * 5}`), aide_id: null, service_code: 'T1019',
      starts_at: iso(start), ends_at: iso(end), status: 'open', open_since: iso(new Date(Date.now() - int(20, 600) * 60e3)), filled_at: null })
  }
  // 30 scheduled shifts next 7 days
  for (let i = 0; i < 30; i++) {
    const start = dayOffset(int(0, 7), int(7, 17))
    const end = new Date(start.getTime() + int(2, 4) * 3600e3)
    shifts.push({ id: uuidFrom(`shift:sched:${i}`), agency_id: A, client_id: uuidFrom(`client:${i}`), aide_id: uuidFrom(`aide:${i % 12}`), service_code: 'T1019',
      starts_at: iso(start), ends_at: iso(end), status: 'scheduled', open_since: null, filled_at: null })
  }
  // 15 filled in the last 7 days (for median-minutes-to-fill)
  for (let i = 0; i < 15; i++) {
    const start = dayOffset(-int(0, 7), int(7, 17))
    const end = new Date(start.getTime() + 3 * 3600e3)
    const openSince = new Date(start.getTime() - int(6, 40) * 3600e3)
    const filledAt = new Date(openSince.getTime() + int(8, 95) * 60e3)
    shifts.push({ id: uuidFrom(`shift:filled:${i}`), agency_id: A, client_id: uuidFrom(`client:${i + 10}`), aide_id: uuidFrom(`aide:${(i + 3) % 12}`), service_code: 'S5125',
      starts_at: iso(start), ends_at: iso(end), status: 'filled', open_since: iso(openSince), filled_at: iso(filledAt) })
  }
  counts.shifts = await upsert(c, 'shifts', shifts)

  // ---------------------------------------------------------------- visits (300 over 30 days)
  const visits: Row[] = []
  const EXC: { idx: number; rule: string; detail: string; severity: string; daysLeft: number }[] = [
    { idx: 3, rule: 'missing_clock_out', detail: 'No clock-out recorded', severity: 'high', daysLeft: 4 },
    { idx: 17, rule: 'missing_clock_out', detail: 'No clock-out recorded', severity: 'high', daysLeft: 12 },
    { idx: 25, rule: 'missing_clock_in', detail: 'No clock-in recorded', severity: 'high', daysLeft: 6 },
    { idx: 41, rule: 'duration_out_of_tolerance', detail: 'Actual 95 min vs scheduled 180 min', severity: 'medium', daysLeft: 21 },
    { idx: 58, rule: 'duration_out_of_tolerance', detail: 'Actual 240 min vs scheduled 120 min', severity: 'medium', daysLeft: 33 },
    { idx: 66, rule: 'gps_outside_geofence', detail: 'Clock-in 2.1 mi from client address', severity: 'medium', daysLeft: 9 },
    { idx: 83, rule: 'gps_outside_geofence', detail: 'Clock-out GPS missing', severity: 'low', daysLeft: 40 },
    { idx: 97, rule: 'service_auth_mismatch', detail: 'Visit billed S5125; authorization is T1019', severity: 'high', daysLeft: 2 },
    { idx: 120, rule: 'units_exceed_auth', detail: 'Visit would exceed remaining authorized units by 6', severity: 'high', daysLeft: 15 },
  ]
  const excByIdx = new Map(EXC.map(e => [e.idx, e]))
  for (let i = 0; i < 300; i++) {
    const daysAgo = Math.floor(i / 10)
    const start = dayOffset(-daysAgo, 7 + (i % 10), (i * 7) % 60)
    const schedMin = [120, 180, 240][i % 3]
    const end = new Date(start.getTime() + schedMin * 60e3)
    const ex = excByIdx.get(i)
    let actualStart: Date | null = new Date(start.getTime() + int(-6, 9) * 60e3)
    let actualEnd: Date | null = new Date(end.getTime() + int(-8, 8) * 60e3)
    let status = 'verified'
    let gpsIn: boolean | null = true, gpsOut: boolean | null = true
    if (ex?.rule === 'missing_clock_out') { actualEnd = null; status = 'unverified' }
    if (ex?.rule === 'missing_clock_in') { actualStart = null; status = 'unverified' }
    if (ex?.rule === 'duration_out_of_tolerance') { actualEnd = new Date(actualStart!.getTime() + (i === 41 ? 95 : 240) * 60e3); status = 'exception' }
    if (ex?.rule === 'gps_outside_geofence') { if (i === 66) gpsIn = false; else gpsOut = null; status = 'exception' }
    if (ex?.rule === 'service_auth_mismatch' || ex?.rule === 'units_exceed_auth') status = 'exception'
    const clientIdx = i % 40
    const claim = ex ? 'unbilled' : daysAgo > 20 ? 'paid' : daysAgo > 10 ? 'submitted' : 'unbilled'
    visits.push({
      id: uuidFrom(`visit:${i}`), agency_id: A, client_id: uuidFrom(`client:${clientIdx}`), aide_id: uuidFrom(`aide:${i % 12}`), shift_id: null,
      service_code: ex?.rule === 'service_auth_mismatch' ? 'S5125' : (clients[clientIdx].service_codes as string[])[0],
      vendor_visit_key: `SND-${100000 + i}`, scheduled_start: iso(start), scheduled_end: iso(end),
      actual_start: actualStart ? iso(actualStart) : null, actual_end: actualEnd ? iso(actualEnd) : null,
      verification_status: status, gps_in_flag: gpsIn, gps_out_flag: gpsOut,
      units: Math.round(schedMin / 15), claim_status: claim, denial_reason: null, source: 'seed',
    })
  }
  counts.visits = await upsert(c, 'visits', visits)
  // RLS control agency: 10 visits + 2 clients nobody at Buckeye may read
  const bClients = [0, 1].map(i => ({ id: uuidFrom(`client:b:${i}`), agency_id: B, first_name: 'Control', last_name: `Client ${i + 1}`, program: 'PASSPORT', county: 'Ross', service_codes: ['T1019'], lat: 39.33, lng: -82.98, active: true }))
  await upsert(c, 'clients', bClients)
  const bVisits: Row[] = []
  for (let i = 0; i < 10; i++) {
    const start = dayOffset(-i, 9)
    bVisits.push({ id: uuidFrom(`visit:b:${i}`), agency_id: B, client_id: uuidFrom(`client:b:${i % 2}`), aide_id: null, shift_id: null, service_code: 'T1019',
      vendor_visit_key: `CTRL-${i}`, scheduled_start: iso(start), scheduled_end: iso(new Date(start.getTime() + 7200e3)), actual_start: iso(start), actual_end: iso(new Date(start.getTime() + 7200e3)),
      verification_status: 'verified', gps_in_flag: true, gps_out_flag: true, units: 8, claim_status: 'paid', denial_reason: null, source: 'seed' })
  }
  counts.visits_control_agency = await upsert(c, 'visits', bVisits)

  // ---------------------------------------------------------------- evv exceptions (9)
  const exceptions: Row[] = EXC.map((e, n) => {
    const v = visits[e.idx]
    return { id: uuidFrom(`exc:${n}`), agency_id: A, visit_id: v.id, rule: e.rule, detail: e.detail, severity: e.severity,
      opened_at: v.scheduled_end, window_closes_at: iso(dayOffset(e.daysLeft, 23, 59)), status: 'open', corrected_at: null, correction_note: null }
  })
  counts.evv_exceptions = await upsert(c, 'evv_exceptions', exceptions)

  // ---------------------------------------------------------------- referrals (3 in flight + 5 answered)
  const referrals: Row[] = [
    { id: uuidFrom('ref:0'), agency_id: A, source_name: 'M. Castellanos', source_org: 'Franklin County AAA', source_channel: 'email', source_email: 'referrals@example.org', client_name: 'New client (PASSPORT)', county: 'Franklin', service: 'T1019', hours_per_week: 20,
      received_at: iso(new Date(Date.now() - 50 * 60e3)), first_response_at: null, responded_by: null, capacity_confirmed_at: null, intake_started_at: null, care_started_at: null, followup_7_at: null, followup_30_at: null, status: 'new', notes: null },
    { id: uuidFrom('ref:1'), agency_id: A, source_name: 'K. Sorensen', source_org: 'Riverside discharge planning', source_channel: 'phone', source_email: null, client_name: 'New client (MyCare)', county: 'Delaware', service: 'S5125', hours_per_week: 12,
      received_at: iso(dayOffset(-1, 14)), first_response_at: iso(dayOffset(-1, 14, 11)), responded_by: 'scheduler', capacity_confirmed_at: iso(dayOffset(-1, 15)), intake_started_at: null, care_started_at: null, followup_7_at: null, followup_30_at: null, status: 'responded', notes: null },
    { id: uuidFrom('ref:2'), agency_id: A, source_name: 'R. Haddad', source_org: 'Franklin County Board of DD', source_channel: 'portal', source_email: null, client_name: 'New client (DODD)', county: 'Franklin', service: 'T2025', hours_per_week: 30,
      received_at: iso(dayOffset(-3, 10)), first_response_at: iso(dayOffset(-3, 10, 22)), responded_by: 'owner', capacity_confirmed_at: iso(dayOffset(-3, 12)), intake_started_at: iso(dayOffset(-2, 9)), care_started_at: null, followup_7_at: null, followup_30_at: null, status: 'intake', notes: null },
  ]
  for (let i = 0; i < 5; i++) {
    const rec = dayOffset(-int(1, 6), int(8, 16))
    const resp = new Date(rec.getTime() + int(4, 38) * 60e3)
    referrals.push({ id: uuidFrom(`ref:done:${i}`), agency_id: A, source_name: pick(['J. Okafor', 'P. Lindqvist', 'A. Nakamura']), source_org: pick(['Franklin County AAA', 'Mount Carmel discharge', 'OhioRISE care coordination']), source_channel: 'email', source_email: null,
      client_name: 'Client (answered)', county: 'Franklin', service: 'T1019', hours_per_week: int(8, 30), received_at: iso(rec), first_response_at: iso(resp), responded_by: 'scheduler',
      capacity_confirmed_at: iso(resp), intake_started_at: iso(new Date(resp.getTime() + 3600e3)), care_started_at: i < 3 ? iso(new Date(resp.getTime() + 2 * 86400e3)) : null,
      followup_7_at: null, followup_30_at: null, status: i < 3 ? 'active' : 'intake', notes: null })
  }
  counts.referrals = await upsert(c, 'referrals', referrals)

  // ---------------------------------------------------------------- applicants (5)
  const applicants: Row[] = [0, 1, 2, 3, 4].map(i => ({
    id: uuidFrom(`applicant:${i}`), agency_id: A, first_name: FIRST[20 + i], last_name: LAST[10 + i], phone: `+1614555${2000 + i}`, email: `applicant${i}@example.com`,
    applied_at: iso(dayOffset(-i, 11)), source: i < 3 ? 'webhook' : 'csv',
    status: i < 2 ? 'new' : i < 4 ? 'screened' : 'interview_booked',
    screen_answers: JSON.stringify(i >= 2 ? { stna: i % 2 === 0, drives: true, availability: 'weekdays', county: 'Franklin' } : {}),
    screen_score: i >= 2 ? (i % 2 === 0 ? 4 : 3) : null, interview_at: i === 4 ? iso(dayOffset(2, 10)) : null,
  }))
  counts.applicants = await upsert(c, 'applicants', applicants)

  // ---------------------------------------------------------------- prospects + touches (staff pipeline)
  const P = [
    { k: 'buckeye', agency_name: 'Buckeye Home Care', owner: 'Dana Whitaker', city: 'Columbus', county: 'Franklin', programs: ['PASSPORT', 'OHCW'], stage: 'assessment_sold', source: 'referral', leak: 'Referrals answered next day; AAA stopped sending', agency_id: A },
    { k: 'p1', agency_name: 'Maple Grove Home Health', owner: 'Chris Petrov', city: 'Dublin', county: 'Franklin', programs: ['PASSPORT', 'MyCare'], stage: 'call_held', source: 'csv', leak: 'EVV exceptions voiding 6-8 claims a month' },
    { k: 'p2', agency_name: 'Northstar Supports', owner: 'Sam Oyelaran', city: 'Westerville', county: 'Delaware', programs: ['DODD'], stage: 'call_held', source: 'csv', leak: 'Open shifts: scheduler texts aides one at a time' },
    { k: 'p3', agency_name: 'Heartland Waiver Services', owner: 'Jo Marchetti', city: 'Newark', county: 'Licking', programs: ['OHCW', 'PASSPORT'], stage: 'call_held', source: 'smartlead', leak: 'Applicants ghost before the interview' },
    { k: 'p4', agency_name: 'Capital City Caregivers', owner: 'Alex Mbeki', city: 'Columbus', county: 'Franklin', programs: ['private-pay'], stage: 'call_booked', source: 'smartlead' },
    { k: 'p5', agency_name: 'Olentangy Home Care', owner: 'Pat Ferreira', city: 'Lewis Center', county: 'Delaware', programs: ['MyCare'], stage: 'replied', source: 'smartlead' },
    { k: 'p6', agency_name: 'Scioto Valley Home Care', owner: 'Lee Brennan', city: 'Chillicothe', county: 'Ross', programs: ['PASSPORT'], stage: 'build_sold', source: 'referral', leak: 'Authorizations run out mid-month', agency_id: B },
    { k: 'p7', agency_name: 'Lancaster Senior Support', owner: 'Robin Kowalski', city: 'Lancaster', county: 'Fairfield', programs: ['PASSPORT'], stage: 'contacted', source: 'smartlead' },
    { k: 'p8', agency_name: 'Grandview Aides LLC', owner: 'Morgan Vance', city: 'Grandview Heights', county: 'Franklin', programs: ['OHCW'], stage: 'new', source: 'csv' },
    { k: 'p9', agency_name: 'Union County Home Help', owner: 'Taylor Abernathy', city: 'Marysville', county: 'Union', programs: ['PASSPORT', 'DODD'], stage: 'lost', source: 'csv' },
    { k: 'p10', agency_name: 'Eastside Family Care', owner: 'Jamie Lachance', city: 'Reynoldsburg', county: 'Franklin', programs: ['MyCare', 'private-pay'], stage: 'new', source: 'site' },
  ]
  const prospects: Row[] = P.map((p, i) => ({
    id: uuidFrom(`prospect:${p.k}`), agency_name: p.agency_name, owner_name: p.owner, email: `${p.owner.split(' ')[0].toLowerCase()}@${p.agency_name.toLowerCase().replace(/[^a-z]/g, '')}.example`,
    phone: `+1614555${3000 + i}`, city: p.city, county: p.county, state: 'OH', programs: p.programs, source: p.source, stage: p.stage, owner_notes: null,
    email_invalid: false, biggest_leak: p.leak ?? null, next_step: p.stage === 'call_booked' ? 'Hold discovery call' : p.stage === 'replied' ? 'Send booking link' : null,
    follow_up_at: ['replied', 'contacted', 'call_held'].includes(p.stage) ? ymd(dayOffset(i % 3)) : null, agency_id: p.agency_id ?? null,
  }))
  counts.prospects = await upsert(c, 'prospects', prospects)
  const touches: Row[] = []
  P.forEach((p, i) => {
    const pid = uuidFrom(`prospect:${p.k}`)
    touches.push({ id: uuidFrom(`touch:${p.k}:0`), prospect_id: pid, channel: p.source === 'site' ? 'site' : 'email', direction: p.source === 'site' ? 'inbound' : 'outbound', subject: p.source === 'site' ? 'Lead from site' : 'Quick question about your referrals', body: p.source === 'site' ? 'We keep losing referrals because nobody answers fast enough.' : 'Short outbound note.', at: iso(dayOffset(-10 + i, 9)), meta: '{}' })
    if (['replied', 'call_booked', 'call_held', 'assessment_sold', 'build_sold'].includes(p.stage)) {
      touches.push({ id: uuidFrom(`touch:${p.k}:1`), prospect_id: pid, channel: 'email', direction: 'inbound', subject: 'Re: Quick question about your referrals', body: 'Sure, happy to talk.', at: iso(dayOffset(-8 + i, 11)), meta: '{}' })
    }
    if (['call_held', 'assessment_sold', 'build_sold'].includes(p.stage)) {
      touches.push({ id: uuidFrom(`touch:${p.k}:2`), prospect_id: pid, channel: 'call', direction: 'outbound', subject: 'Discovery call', body: `Biggest leak named: ${p.leak}`, at: iso(dayOffset(-5 + (i % 3), 14)), meta: JSON.stringify({ outcome: 'held', biggest_leak: p.leak }) })
    }
  })
  counts.touches = await upsert(c, 'touches', touches)

  // ---------------------------------------------------------------- assessment shell for Buckeye
  counts.assessments = await upsert(c, 'assessments', [{
    id: uuidFrom('assessment:buckeye'), prospect_id: uuidFrom('prospect:buckeye'), agency_id: A, status: 'in_progress',
    inputs: JSON.stringify({ avg_monthly_referrals: 9, avg_referral_value_year: 18000, aide_turnover_12mo: 7, open_shift_hours_week: 22, evv_denial_rate: 0.06 }),
    leaks: '[]', recommended_door: null, report_path: null, report_generated_at: null,
  }])

  await c.end()
  return counts
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  seed().then(counts => { console.log('seed complete:', counts) }).catch(e => { console.error(e); process.exit(1) })
}
