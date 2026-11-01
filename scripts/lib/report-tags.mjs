// 주간·월간 보고서가 함께 쓰는 태그 정리 규칙.
//
// 태그는 AI 가 자유 텍스트로 붙여서 문자열의 83% 가 한 번만 쓰인다(2026-11 실측). 같은 주제가
// "우주항공·항공우주·위성·Aerospace" 로 흩어지므로 문자열 그대로 세면 표기가 바뀐 것을 주제가 줄어든
// 것으로 읽게 된다 — 10월 월간에서 "우주항공 23→6" 으로 나갔지만 주제 단위로는 월 17→13 이었다.
// 그래서 자주 나오는 주제는 아래 목록으로 묶고, 나머지는 공백·대소문자만 맞춰 센다(새 주제는 그대로 보인다).

const norm = (t) => String(t ?? '').toLowerCase().replace(/[\s\-_·.]/g, '')

// 위에서부터 처음 맞는 주제로 간다. 순서가 의미를 가진다(에이전트 커머스 → 에이전트, 직원보안교육 → 보안).
const THEMES = [
  ['AI 에이전트', /에이전트|agent/],
  ['보안', /보안|security/],
  ['컴플라이언스·규제', /컴플라이언스|규제|regtech|compliance/],
  ['우주·위성', /우주|위성|aerospace|^space|spacetech/], // workspace 같은 단어에 걸리지 않게 space 는 앞에서만
  ['드론', /드론|무인항공|uav|drone/],
  ['자율주행', /자율주행|로보택시|autonomous/],
  ['로보틱스', /로봇|로보틱스|휴머노이드|robot/],
  ['헬스케어', /헬스|의료|health|원격진료/],
  ['바이오·신약', /바이오|신약|biotech/],
  ['양자', /양자|quantum/],
  ['반도체', /반도체|semiconductor/],
  ['데이터센터', /데이터센터|datacenter/],
  ['방산', /방산|국방|방위|defense|defence/],
  ['가상자산', /스테이블코인|크립토|블록체인|가상자산|web3|stablecoin|crypto/],
  ['기후·클린테크', /기후|클린테크|탄소|climate|cleantech/],
  ['개발자 도구', /개발자|devtool|developer/],
  ['교육', /에듀테크|교육|edtech/],
  ['이커머스', /커머스|commerce/],
]

// 분야(category) 수준이라 "떠오르는 태그"로는 정보가 없는 것들
const GENERIC = new Set(['ai', 'b2b', 'b2c', 'saas', 'b2bsaas', '하드웨어', '딥테크', 'deeptech', '인프라', '자동화',
  '생성형ai', '스타트업', '플랫폼', '소프트웨어', '테크'])

// 지역명 태그는 지역 축과 중복이다. "중국 스타트업·프랑스스타트업·중국 테크" 같은 변형까지 거른다.
const PLACES = '유럽|미국|북미|남미|중남미|라틴아메리카|동남아시아|동남아|아시아|중동|아프리카|중국|인도|일본|한국|대만|홍콩|' +
  '영국|독일|프랑스|스페인|이탈리아|네덜란드|스웨덴|노르웨이|덴마크|핀란드|스위스|오스트리아|벨기에|아일랜드|포르투갈|폴란드|에스토니아|' +
  '이스라엘|튀르키예|터키|사우디|사우디아라비아|아랍에미리트|uae|캐나다|브라질|멕시코|싱가포르|인도네시아|베트남|태국|필리핀|말레이시아|' +
  '호주|뉴질랜드|나이지리아|케냐|이집트|' +
  'europe|european|usa|us|uk|asia|china|chinese|india|japan|korea|germany|france|israel|singapore|canada|latam'
const REGION = new RegExp(`^(${PLACES})(스타트업|테크|기업|시장|진출|startup|startups|tech)?$`)

export const isRegionTag = (t) => REGION.test(norm(t))

// 태그 → 주제 키. 셀 필요가 없는 태그는 null.
export function themeOf(tag) {
  const n = norm(tag)
  if (!n || GENERIC.has(n) || REGION.test(n)) return null
  for (const [label, re] of THEMES) if (re.test(n)) return label
  return n
}

// 행 목록 → Map(주제 → 그 주제가 붙은 행 수). 한 행이 같은 주제를 여러 번 달아도 1로 센다.
// 화면에 쓸 이름은 주제 목록의 이름, 없으면 그 키로 가장 많이 쓰인 원래 표기.
export function themeCounts(rows) {
  const counts = new Map()
  const spell = new Map()
  for (const r of rows) {
    const seen = new Set()
    for (const t of r.tags ?? []) {
      const k = themeOf(t)
      if (!k || seen.has(k)) continue
      seen.add(k)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      const s = (spell.get(k) ?? new Map())
      s.set(t, (s.get(t) ?? 0) + 1)
      spell.set(k, s)
    }
  }
  const labelOf = (k) => THEMES.some(([l]) => l === k) ? k : [...(spell.get(k) ?? [[k, 0]])].sort((a, b) => b[1] - a[1])[0][0]
  return { counts, labelOf }
}

// 두 비율 차이의 z 값. 주간·월간이 같은 기준으로 "변화"를 부르도록 여기 둔다.
export function zDiff(p1, n1, p2, n2) {
  if (!n1 || !n2) return 0
  const p = (p1 * n1 + p2 * n2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  return se ? (p1 - p2) / se : 0
}
