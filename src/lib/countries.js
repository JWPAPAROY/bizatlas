// 수집 데이터의 영문 국가명 → 화면용 한국어. 없으면 영문 그대로.
const COUNTRY_KO = {
  'united states': '미국', 'united kingdom': '영국', china: '중국', germany: '독일', singapore: '싱가포르', france: '프랑스',
  sweden: '스웨덴', netherlands: '네덜란드', italy: '이탈리아', switzerland: '스위스', india: '인도', belgium: '벨기에',
  spain: '스페인', denmark: '덴마크', finland: '핀란드', lithuania: '리투아니아', japan: '일본', portugal: '포르투갈',
  indonesia: '인도네시아', ukraine: '우크라이나', norway: '노르웨이', estonia: '에스토니아', romania: '루마니아',
  israel: '이스라엘', canada: '캐나다', australia: '호주', brazil: '브라질', poland: '폴란드', ireland: '아일랜드',
  austria: '오스트리아', taiwan: '대만', malaysia: '말레이시아', 'new zealand': '뉴질랜드', turkey: '튀르키예', nigeria: '나이지리아', kenya: '케냐', 'hong kong': '홍콩', vietnam: '베트남', mexico: '멕시코', 'united arab emirates': 'UAE',
}
export const countryKo = (c) => COUNTRY_KO[(c ?? '').trim().toLowerCase()] ?? c
