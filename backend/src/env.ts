// Minimal .env loader (no dependency). Reads backend/.env.local then backend/.env;
// real environment variables always win.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnv(dir: string) {
  for (const name of ['.env.local', '.env']) {
    const file = resolve(dir, name)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!m || process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}
