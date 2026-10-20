/** File storage for generated reports. Supabase Storage when configured, else ./.storage on disk. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env } from './env'

export async function putFile(path: string, bytes: Uint8Array | Buffer, contentType = 'application/pdf'): Promise<{ path: string }> {
  if (env.hasSupabase && env.supabaseServiceKey) {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(env.supabaseUrl, env.supabaseServiceKey)
    await sb.storage.createBucket(env.storageBucket, { public: false }).catch(() => {})
    const { error } = await sb.storage.from(env.storageBucket).upload(path, bytes, { contentType, upsert: true })
    if (error) throw error
    return { path }
  }
  const full = join(process.cwd(), '.storage', env.storageBucket, path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, bytes)
  return { path }
}

export async function getFile(path: string): Promise<Buffer> {
  if (env.hasSupabase && env.supabaseServiceKey) {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(env.supabaseUrl, env.supabaseServiceKey)
    const { data, error } = await sb.storage.from(env.storageBucket).download(path)
    if (error || !data) throw error ?? new Error('not found')
    return Buffer.from(await data.arrayBuffer())
  }
  return readFile(join(process.cwd(), '.storage', env.storageBucket, path))
}
