/**
 * 把一份 calibre 安装目录复制到 vendor/calibre，供 electron-builder.fix.yml 打进安装包。
 *
 * 用法：
 *   npm run calibre:vendor                   # 自动找 Program Files\Calibre2
 *   npm run calibre:vendor -- "D:\Calibre2"  # 指定一份 calibre
 *
 * 只做复制，不修改 calibre 的任何文件（GPLv3 独立程序，按原样随包分发）。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const arg = process.argv[2]
const candidates = [
  arg,
  process.env.EEBOOKK_CALIBRE_DIR,
  process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Calibre2') : '',
  'C:\\Program Files\\Calibre2',
  'C:\\Program Files (x86)\\Calibre2'
].filter((v) => typeof v === 'string' && v.length > 0)

const src = candidates.find((p) => existsSync(join(p, 'calibredb.exe')))
if (!src) {
  console.error('找不到 calibre：先装一份 calibre，或把它的安装目录作为参数传进来。')
  process.exit(1)
}

const dest = join(process.cwd(), 'vendor', 'calibre')
const started = Date.now()
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`calibre ${src} -> ${dest}（${Math.round((Date.now() - started) / 1000)}s）`)
