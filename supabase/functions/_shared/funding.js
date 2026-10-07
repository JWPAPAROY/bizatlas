// traction.funding(자유 텍스트) → { usd_m, stage } 구조화.
//
// 왜 AI 가 아니라 정규식인가: 원문은 이미 AI 가 "원문에 명시된 수치만" 옮겨 적은 한 줄이라
// 여기서 할 일은 해석이 아니라 파싱이다. AI 쿼터를 쓰지 않고, 같은 입력에 항상 같은 답이 나오며,
// 규칙을 고치면 백필 스크립트로 전체를 즉시 다시 계산할 수 있다.
//
// 엣지 함수(Deno)와 로컬 백필(Node)이 같은 파일을 import 한다 — 규칙을 두 벌로 두지 말 것.
//
// 원문 예: "$50M 시리즈 C (인사이트 파트너스 주도, 총 1억 1천만 달러 조달)"
//          "€4.5 million ($5.3 million) 시드 라운드" · "3,600만 달러 (… 2,300만 달러 시리즈 A 포함)"
//          "HK$4.96B (홍콩 증시 H주 상장 공모)" · "YC S26 배치" · "$830M 대출 확보"

// 고정 환율(USD 기준, 2026 근사). 트렌드 비교용이라 소수점 정밀도는 필요 없다 — 화면에도 근사임을 밝힌다.
const FX = {
  USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.13, SEK: 0.095, NOK: 0.093, DKK: 0.145,
  PLN: 0.25, HKD: 0.128, SGD: 0.75, JPY: 0.0067, CNY: 0.14, INR: 0.012,
  KRW: 0.00073, AUD: 0.66, CAD: 0.73, IDR: 0.000062, ILS: 0.27,
}

// 기호·코드·한국어 통화명 → ISO. 긴 것부터 맞춰야 HK$ 가 $ 로 잡히지 않는다.
const CUR_TOKENS = [
  ['HK$', 'HKD'], ['S$', 'SGD'], ['A$', 'AUD'], ['C$', 'CAD'], ['US$', 'USD'],
  ['RMB', 'CNY'], ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₩', 'KRW'], ['₹', 'INR'],
]
const CUR_CODES = [...Object.keys(FX), 'RMB']
const CUR_WORDS = {
  달러: 'USD', 유로: 'EUR', 파운드: 'GBP', 엔: 'JPY', 위안: 'CNY', 원: 'KRW',
  홍콩달러: 'HKD', 싱가포르달러: 'SGD', 크로나: 'SEK', 크로네: 'NOK', 루피: 'INR', 프랑: 'CHF',
}

// "1억 1천만" · "3,600만" · "2억" 같은 한국어 수사 → 숫자
function koreanNumber(s) {
  let total = 0
  const eok = s.match(/([\d.,]+)\s*억/)
  if (eok) total += parseFloat(eok[1].replace(/,/g, '')) * 1e8
  const rest = eok ? s.slice(s.indexOf('억') + 1) : s
  const man = rest.match(/([\d.,]+)\s*(천)?\s*만/)
  if (man) total += parseFloat(man[1].replace(/,/g, '')) * (man[2] ? 1e7 : 1e4)
  else {
    const cheonMan = rest.match(/([\d.,]+)\s*천\s*만/)
    if (cheonMan) total += parseFloat(cheonMan[1]) * 1e7
  }
  return total || null
}

const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }

// 문자열에서 첫 번째 금액을 찾아 [USD 금액(달러), 매칭 위치]를 돌려준다.
function firstAmount(text) {
  const hits = []

  // ① 기호/코드 + 숫자 + 단위:  $50M · €4.5 million · HK$4.96B · SEK 6M · USD 20M
  const sym = CUR_TOKENS.map(([t]) => t.replace(/\$/g, '\\$')).join('|')
  const re1 = new RegExp(`(${sym}|\\b(?:${CUR_CODES.join('|')})\\b)\\s?([\\d][\\d.,]*)\\s?(k|thousand|mn|m|million|bn|b|billion)?\\b`, 'gi')
  for (const m of text.matchAll(re1)) {
    const tok = m[1].toUpperCase()
    const cur = CUR_TOKENS.find(([t]) => t === m[1] || t === tok)?.[1] ?? (FX[tok] ? tok : null)
    if (!cur) continue
    let v = parseFloat(m[2].replace(/,/g, ''))
    const unit = (m[3] ?? '').toLowerCase()
    if (unit) v *= SCALE[unit]
    else if (v < 1000) continue // "$5" 처럼 단위 없는 작은 수는 금액이 아니다(오탐 방지)
    hits.push([v * FX[cur], m.index, m.index + m[0].length])
  }

  // ② 한국어 수사 + 통화명:  1억 1천만 달러 · 3,600만 달러 · 200만 유로
  const words = Object.keys(CUR_WORDS).sort((a, b) => b.length - a.length).join('|')
  const re2 = new RegExp(`([\\d.,]+\\s*억(?:\\s*[\\d.,]+\\s*천?\\s*만)?|[\\d.,]+\\s*천?\\s*만)\\s*(${words})`, 'g')
  for (const m of text.matchAll(re2)) {
    const v = koreanNumber(m[1])
    if (v) hits.push([v * FX[CUR_WORDS[m[2]]], m.index, m.index + m[0].length])
  }

  // ③ 숫자 + 영문 단위 + 통화명:  2 million euros
  const re3 = /([\d][\d.,]*)\s?(million|billion|thousand)\s+(dollars|euros|pounds)/gi
  for (const m of text.matchAll(re3)) {
    const cur = { dollars: 'USD', euros: 'EUR', pounds: 'GBP' }[m[3].toLowerCase()]
    hits.push([parseFloat(m[1].replace(/,/g, '')) * SCALE[m[2].toLowerCase()] * FX[cur], m.index, m.index + m[0].length])
  }

  if (!hits.length) return null
  hits.sort((a, b) => a[1] - b[1])
  return hits[0]
}

// 단계 판정. 순서가 의미를 가진다 — 앞에서 먼저 걸린 것이 이긴다.
// "프리시리즈 A"는 A 가 아니라 seed 쪽, "시리즈 시드"는 seed, IPO·대출·보조금은 VC 라운드가 아니다.
const STAGE_RULES = [
  ['ipo', /\bipo\b|상장|공모|listing|spac/i],
  ['acquisition', /인수|acqui|매각|buyout/i],
  ['debt', /대출|차입|부채|빚|\bdebt\b|\bloans?\b|credit|신용|\brcf\b|채권|신디케이트\s?론/i],
  ['other', /계약|contract|\baward\b|이니셔티브|initiative|투자\s?계획|조달\s?계획|구조조정|tax credit/i],
  ['grant', /보조금|\bgrant\b|연구\s?기금|정부\s?지원|horizon|eic accelerator|innovate uk/i],
  ['pre_seed', /프리\s?시드|pre[-\s]?seed/i],
  ['seed', /프리\s?시리즈\s?a|pre[-\s]?series\s?a|pre[-\s]?a\b|시드|\bseed\b|엔젤/i],
  ['series_a', /시리즈\s?a\b|series\s?a\b|a\s?라운드/i],
  ['series_b', /시리즈\s?b\b|series\s?b\b|b\s?라운드/i],
  ['series_c', /시리즈\s?c\b|series\s?c\b|c\s?라운드/i],
  ['series_d_plus', /시리즈\s?[d-j]\b|series\s?[d-j]\b|[d-j]\s?라운드/i],
  ['accelerator', /\byc\b|y\s?combinator|배치|batch|액셀러레이터|accelerator|techstars/i],
  ['growth', /성장\s?(투자|자금)|growth|소수\s?지분|지분\s?투자|전략적\s?투자|strategic|사모|private equity|유상증자/i],
]

// VC 라운드로 볼 단계(트렌드 중앙값 계산 대상). IPO·대출·보조금은 성격이 달라 섞으면 중앙값이 왜곡된다.
export const VC_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus', 'growth']

export function parseFunding(raw) {
  if (raw == null) return { usd_m: null, stage: null }
  const text = String(raw).trim()
  if (!text) return { usd_m: null, stage: null }

  // 원문 앞쪽에 나온 단계가 첫 금액의 단계다. "$40M 시리즈 A …, 시드 라운드 (…)"처럼 이력이 이어지면
  // 규칙 순서로 고르면 시드가 이긴다. 같은 위치면 규칙 순서(프리시리즈 A → seed)가 이긴다.
  let stage = null
  let at = Infinity
  for (const [s, re] of STAGE_RULES) {
    const m = re.exec(text)
    if (m && m.index < at) { stage = s; at = m.index }
  }

  // 금액 바로 뒤의 말이 성격을 바꾼다 (쉼표·괄호 전까지만 본다):
  //   "목표·협상 중"   → 아직 일어나지 않은 라운드
  //   "가치·밸류에이션" → 조달액이 아니라 기업가치 ("$4.5B valuation", "10억 달러 가치로")
  //   "누적"           → 한 라운드가 아니라 총액
  let usd_m = null
  const hit = firstAmount(text)
  if (hit) {
    const tail = text.slice(hit[2], hit[2] + 30).split(/[,(/]/)[0]
    const head = text.slice(Math.max(0, hit[1] - 6), hit[1])
    const notRound = /목표|협상|논의|추진|target|seeking|가치|밸류|valuation|시가총액|평가|누적/i.test(tail) ||
      /누적|시가총액/.test(head)
    if (!notRound) usd_m = Math.round((hit[0] / 1e6) * 100) / 100
  }

  // 금액도 단계도 못 찾았는데 투자 언급은 있다 → 금액 미공개 라운드
  if (!stage && usd_m == null && /투자|funding|raised|유치|라운드/i.test(text)) stage = 'undisclosed'
  if (!stage && usd_m != null) stage = 'unknown'
  return { usd_m, stage }
}
