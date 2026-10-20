import type { Db } from '../db'

export type SettingKey = 'baa_template' | 'sow_template' | 'booking_url'

export async function getSettings(db: Db): Promise<Partial<Record<SettingKey, Record<string, unknown>>>> {
  const rows = await db.query<{ key: SettingKey; value: Record<string, unknown> }>('select key, value from settings')
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

export async function upsertSetting(db: Db, key: SettingKey, value: Record<string, unknown>, updatedBy: string | null) {
  await db.query(
    `insert into settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), updatedBy])
}

export function settingString(v: Record<string, unknown> | undefined, field: string): string | null {
  const x = v?.[field]
  return typeof x === 'string' && x.trim() ? x : null
}
