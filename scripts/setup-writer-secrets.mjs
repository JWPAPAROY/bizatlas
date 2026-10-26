// 쓰기 시크릿 설정 — 사람이 직접 한 번 실행한다(시크릿 쓰기는 자동 실행에서 막힌다).
//
//   opportunities : scripts/opportunities.mjs 가 GitHub Actions 에서 쓴다 → GitHub secret OPPORTUNITY_SECRET
//   field         : /opportunities 화면의 "검증 기록 잠금 해제" 에 넣는다 → 브라우저에만
//
// 하는 일: 무작위 값 생성 → 원본을 ~/.secrets/supabase-pat.txt 에 BIZATLAS_*_SECRET 로 추가
//          → 해시를 private.writer_secrets 에 등록(Management API) → OPPORTUNITY_SECRET 을 gh 로 등록.
// 이미 로컬에 값이 있으면 새로 만들지 않고 그 값을 다시 등록한다(재실행 안전).
//
// 사용법:  node scripts/setup-writer-secrets.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const SECRETS = path.join(os.homedir(), '.secrets', 'supabase-pat.txt')
const NAMES = [['opportunities', 'BIZATLAS_OPPORTUNITY_SECRET'], ['field', 'BIZATLAS_FIELD_SECRET']]

let text = fs.readFileSync(SECRETS, 'utf8')
const read = (k) => text.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1].trim()
const pat = read('SUPABASE_PAT')
const ref = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
if (!pat || !ref) throw new Error('SUPABASE_PAT 또는 .env 의 VITE_SUPABASE_URL 이 없다')

const values = {}
for (const [name, key] of NAMES) {
  values[name] = read(key)
  if (!values[name]) {
    values[name] = crypto.randomBytes(24).toString('base64url')
    text = text.replace(/\n*$/, '\n') + `${key}=${values[name]}\n`
    console.log(`새로 만듦: ${key}`)
  } else {
    console.log(`기존 값 사용: ${key}`)
  }
}
fs.writeFileSync(SECRETS, text)

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex')
const query = `insert into private.writer_secrets (name, sha256) values ${NAMES.map(([n]) => `('${n}', '${sha(values[n])}')`).join(', ')}
  on conflict (name) do update set sha256 = excluded.sha256;`
const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
})
if (!r.ok) throw new Error(`해시 등록 실패 ${r.status}: ${await r.text()}`)
console.log('DB 해시 등록: opportunities, field')

execFileSync('gh', ['secret', 'set', 'OPPORTUNITY_SECRET', '--body', values.opportunities], { cwd: new URL('..', import.meta.url), stdio: 'inherit' })
console.log('GitHub secret 등록: OPPORTUNITY_SECRET')

console.log(`\n화면 잠금 해제에 넣을 field 시크릿은 ${SECRETS} 의 BIZATLAS_FIELD_SECRET 값입니다.`)
