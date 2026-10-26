import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** Write JSON/text through a sibling temp file so a crash cannot leave a partial file. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, data, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      if (existsSync(temp)) {
        // Best-effort cleanup; preserve the original error for the caller.
        rmSync(temp, { force: true })
      }
    } catch {
      /* Ignore cleanup failures. */
    }
    throw error
  }
}

/** Return true when target resolves to root itself or a descendant of root. */
export function isWithin(root: string, target: string): boolean {
  const base = resolve(root)
  const child = resolve(target)
  return child === base || child.startsWith(`${base}${sep}`)
}
