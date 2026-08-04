// DART 법인 고유번호(corpCode.xml)를 dart_corps 테이블에 적재한다.
//
// 왜 로컬 스크립트인가: corpCode.xml 은 10만 건이 넘는 ZIP 이라 엣지 함수의 150초 제한 안에서
// 내려받고 풀고 적재하기 어렵다. 법인 목록은 자주 안 바뀌므로 분기 1회 수동 실행이면 충분하다.
//
// 사용법:
//   DART_API_KEY=xxx SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxx \
//     node scripts/sync-dart-corps.mjs
//
// 키는 .secrets 에 두고 셸에서 읽어 넘기는 것을 권장한다 (repo 에 커밋 금지).

import { unzipSync, strFromU8 } from 'fflate'

const DART_KEY = process.env.DART_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!DART_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('DART_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.')
  process.exit(1)
}

const BATCH = 1000

async function main() {
  console.log('corpCode.xml 내려받는 중...')
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`)
  if (!res.ok) throw new Error(`DART HTTP ${res.status}`)

  const buf = new Uint8Array(await res.arrayBuffer())

  // 키가 틀리면 ZIP 이 아니라 에러 XML 이 온다
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`ZIP 이 아닙니다. 응답: ${strFromU8(buf).slice(0, 300)}`)
  }

  const files = unzipSync(buf)
  const xmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith('.xml'))
  if (!xmlName) throw new Error('ZIP 안에 XML 이 없습니다.')
  const xml = strFromU8(files[xmlName])
  console.log(`압축 해제 완료: ${xmlName} (${(xml.length / 1e6).toFixed(1)}MB)`)

  const rows = []
  const re = /<list>([\s\S]*?)<\/list>/g
  const pick = (chunk, tag) => {
    const m = chunk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }

  let m
  while ((m = re.exec(xml)) !== null) {
    const c = m[1]
    const corp_code = pick(c, 'corp_code')
    const corp_name = pick(c, 'corp_name')
    if (!corp_code || !corp_name) continue
    const stock_code = pick(c, 'stock_code') || null
    rows.push({ corp_code, corp_name, stock_code, modify_date: pick(c, 'modify_date') || null })
  }
  console.log(`파싱 완료: ${rows.length.toLocaleString()}건`)

  let done = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/dart_corps?on_conflict=corp_code`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(slice),
    })
    if (!r.ok) throw new Error(`적재 실패 (${i}): HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    done += slice.length
    if (done % 10000 === 0 || done === rows.length) {
      console.log(`  적재 ${done.toLocaleString()} / ${rows.length.toLocaleString()}`)
    }
  }

  const listed = rows.filter((r) => r.stock_code).length
  console.log(`\n완료: 전체 ${rows.length.toLocaleString()}건 (상장사 ${listed.toLocaleString()}건)`)
}

main().catch((e) => {
  console.error('실패:', e.message)
  process.exit(1)
})
