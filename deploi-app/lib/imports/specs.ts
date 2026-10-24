/**
 * Import specifications: the documented fields, types, required flags and identity rules per import kind.
 * The templates, the validation, the duplicate detection and the import pages all read from here, so the
 * CSV a customer downloads is exactly what the validator expects.
 *
 * Evidence rule (EVV): a blank cell stays null. The importer never fabricates a clock-in, clock-out, GPS
 * flag, signature, verification or delivered units. Units are taken from the file; when the file has no
 * units column they are derived only from a recorded clock-in AND clock-out using the agency's EVV rule set
 * (unit_minutes / rounding), never from the schedule.
 */
export type ImportKind = 'evv_visits' | 'applicants' | 'aides'
export type FieldType = 'text' | 'phone' | 'email' | 'datetime' | 'date' | 'number' | 'flag' | 'status' | 'code' | 'list'

export type FieldSpec = {
  key: string
  label: string
  required: boolean
  type: FieldType
  doc: string
  example: string
  /** header spellings the auto-mapper accepts, lower-cased, punctuation-insensitive */
  synonyms: string[]
}

export type ImportSpec = {
  kind: ImportKind
  label: string
  table: 'visits' | 'applicants' | 'aides'
  /** which fields identify the same record (in-file and against existing rows), in priority order */
  identity: { by: 'vendor_key' | 'phone' | 'email' | 'name'; fields: string[] }[]
  fields: FieldSpec[]
  notes: string[]
}

const IDENTITY_NAME = { by: 'name' as const, fields: ['first_name', 'last_name'] }

export const IMPORT_SPECS: Record<ImportKind, ImportSpec> = {
  evv_visits: {
    kind: 'evv_visits', label: 'EVV visits', table: 'visits',
    identity: [{ by: 'vendor_key', fields: ['vendor_visit_key'] }],
    fields: [
      { key: 'vendor_visit_key', label: 'Visit key', required: true, type: 'code', doc: "The vendor's visit id. One row per visit; the same key on re-import updates the visit and keeps a revision.", example: 'SND-900001', synonyms: ['visitkey', 'visit key', 'visit_key', 'visit id', 'visitid', 'visit_id', 'key', 'id'] },
      { key: 'client_name', label: 'Client name', required: false, type: 'text', doc: '"First Last" or "Last, First"; matched to the agency roster. Unmatched stays unlinked (authorization rules skip).', example: 'Avery Okafor', synonyms: ['clientname', 'client name', 'client', 'patient', 'patient name', 'member', 'member name', 'recipient', 'recipient name'] },
      { key: 'client_ref', label: 'Client ID', required: false, type: 'code', doc: "The vendor's client / Medicaid id. Kept for reference.", example: 'C0001', synonyms: ['clientid', 'client id', 'client_id', 'patient id', 'member id', 'medicaid id', 'recipient id'] },
      { key: 'employee_name', label: 'Employee name', required: false, type: 'text', doc: 'Aide name, matched like the client name.', example: 'Jordan Lindqvist', synonyms: ['employeename', 'employee name', 'employee', 'caregiver', 'caregiver name', 'aide', 'aide name', 'worker', 'staff'] },
      { key: 'service_code', label: 'Service code', required: true, type: 'code', doc: 'HCPCS / procedure code (T1019, S5125, G0156, T2025 …). Upper-cased.', example: 'T1019', synonyms: ['service', 'service code', 'servicecode', 'procedure', 'procedure code', 'hcpcs'] },
      { key: 'scheduled_start', label: 'Scheduled start', required: false, type: 'datetime', doc: 'Wall-clock time in the agency timezone unless the value carries an offset. ISO or MM/DD/YYYY h:mm AM.', example: '2026-10-15 08:00', synonyms: ['schedulestarttime', 'scheduled start', 'schedule start', 'sched start', 'scheduled_start', 'planned start', 'start scheduled'] },
      { key: 'scheduled_end', label: 'Scheduled end', required: false, type: 'datetime', doc: 'Same format as scheduled start.', example: '2026-10-15 10:00', synonyms: ['scheduleendtime', 'scheduled end', 'schedule end', 'sched end', 'scheduled_end', 'planned end', 'end scheduled'] },
      { key: 'actual_start', label: 'Actual start (clock-in)', required: false, type: 'datetime', doc: 'Blank means no clock-in was recorded. Never filled in from the schedule.', example: '2026-10-15 07:58', synonyms: ['callintime', 'call in time', 'call-in', 'clock in', 'clock-in', 'clockin', 'actual start', 'actual_start', 'check in', 'visit start', 'start time'] },
      { key: 'actual_end', label: 'Actual end (clock-out)', required: false, type: 'datetime', doc: 'Blank means no clock-out was recorded.', example: '2026-10-15 10:03', synonyms: ['callouttime', 'call out time', 'call-out', 'clock out', 'clock-out', 'clockout', 'actual end', 'actual_end', 'check out', 'visit end', 'end time'] },
      { key: 'verification_status', label: 'Verification status', required: false, type: 'status', doc: 'Verified / Unverified / Exception (vendor wording accepted). Blank = unverified.', example: 'Verified', synonyms: ['visitstatus', 'visit status', 'verification status', 'verification', 'status', 'evv status', 'verified'] },
      { key: 'gps_in_flag', label: 'GPS in flag', required: false, type: 'flag', doc: 'Y/N, true/false, in/out. Blank = GPS missing (stays null).', example: 'Y', synonyms: ['callingps', 'call in gps', 'gps in', 'gps_in', 'clock in gps', 'gps in geofence', 'geofence in'] },
      { key: 'gps_out_flag', label: 'GPS out flag', required: false, type: 'flag', doc: 'Same as GPS in.', example: 'Y', synonyms: ['calloutgps', 'call out gps', 'gps out', 'gps_out', 'clock out gps', 'gps out geofence', 'geofence out'] },
      { key: 'units', label: 'Units', required: false, type: 'number', doc: 'Billable units, numeric and ≥ 0. Blank: derived from clock-in/clock-out with the rule set (unit_minutes, rounding), never from the schedule.', example: '8', synonyms: ['units', 'billable units', 'unit count'] },
    ],
    notes: [
      'Dates without an offset are read in the agency timezone.',
      'A row with a duplicate visit key inside the file is reported and the first occurrence wins.',
      'Re-importing a file with the same content is reported as "already imported" and changes nothing.',
      'A visit whose exceptions were corrected or dismissed keeps its original evidence in visit_revisions when the re-import changes it.',
    ],
  },
  applicants: {
    kind: 'applicants', label: 'Applicants', table: 'applicants',
    identity: [{ by: 'phone', fields: ['phone'] }, IDENTITY_NAME],
    fields: [
      { key: 'first_name', label: 'First name', required: true, type: 'text', doc: 'Required.', example: 'Avery', synonyms: ['first_name', 'first name', 'first', 'given name', 'firstname'] },
      { key: 'last_name', label: 'Last name', required: true, type: 'text', doc: 'Required.', example: 'Okafor', synonyms: ['last_name', 'last name', 'last', 'surname', 'family name', 'lastname'] },
      { key: 'phone', label: 'Mobile phone', required: false, type: 'phone', doc: 'US number, 10 digits or +1XXXXXXXXXX. Needed for the SMS screen. Duplicate numbers are skipped.', example: '+16145550199', synonyms: ['phone', 'mobile', 'cell', 'phone number', 'mobile phone', 'telephone'] },
      { key: 'email', label: 'Email', required: false, type: 'email', doc: 'Optional.', example: 'avery@example.com', synonyms: ['email', 'e-mail', 'email address'] },
      { key: 'applied_at', label: 'Applied on', required: false, type: 'date', doc: 'YYYY-MM-DD or MM/DD/YYYY. Blank = today.', example: '2026-10-20', synonyms: ['applied_at', 'applied', 'applied on', 'date applied', 'application date'] },
      { key: 'source', label: 'Source', required: false, type: 'text', doc: 'Where the applicant came from (indeed, referral, walk-in …). Blank = csv.', example: 'indeed', synonyms: ['source', 'channel', 'origin'] },
    ],
    notes: ['SMS consent is never set by an import; it is recorded on the applicant before any text goes out.'],
  },
  aides: {
    kind: 'aides', label: 'Aide roster', table: 'aides',
    identity: [{ by: 'phone', fields: ['phone'] }, { by: 'email', fields: ['email'] }, IDENTITY_NAME],
    fields: [
      { key: 'first_name', label: 'First name', required: true, type: 'text', doc: 'Required.', example: 'Jordan', synonyms: ['first_name', 'first name', 'first', 'firstname'] },
      { key: 'last_name', label: 'Last name', required: true, type: 'text', doc: 'Required.', example: 'Lindqvist', synonyms: ['last_name', 'last name', 'last', 'surname', 'lastname'] },
      { key: 'phone', label: 'Mobile phone', required: false, type: 'phone', doc: 'US number. Used for shift offers and reminders once consent is recorded.', example: '+16145551001', synonyms: ['phone', 'mobile', 'cell', 'phone number', 'mobile phone'] },
      { key: 'email', label: 'Email', required: false, type: 'email', doc: 'Optional.', example: 'jordan@example.com', synonyms: ['email', 'e-mail', 'email address'] },
      { key: 'hired_on', label: 'Hired on', required: false, type: 'date', doc: 'YYYY-MM-DD. Drives the 30/60/90-day check-ins.', example: '2026-09-01', synonyms: ['hired_on', 'hired', 'hire date', 'start date', 'hired on'] },
      { key: 'services', label: 'Service codes', required: false, type: 'list', doc: 'Semicolon- or pipe-separated codes the aide may deliver (T1019;S5125).', example: 'T1019;S5125', synonyms: ['services', 'service codes', 'skills', 'certifications'] },
    ],
    notes: ['Credentials and their expiry dates are not imported here; they are maintained on the aide record.'],
  },
}

export const IMPORT_KINDS = Object.keys(IMPORT_SPECS) as ImportKind[]
export const isImportKind = (k: string): k is ImportKind => k in IMPORT_SPECS
export function requiredFields(spec: ImportSpec): string[] { return spec.fields.filter(f => f.required).map(f => f.key) }
