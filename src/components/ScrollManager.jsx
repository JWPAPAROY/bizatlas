import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// HashRouter 는 ScrollRestoration 을 쓸 수 없어 직접 한다.
// 새 화면으로 들어가면 맨 위에서, 뒤로가기면 떠날 때의 위치에서 시작한다.
// 같은 화면 안의 주소 변경(필터)은 스크롤을 건드리지 않는다.
const saved = new Map()

export default function ScrollManager() {
  const { key, pathname } = useLocation()
  const navType = useNavigationType()

  // 떠나는 화면의 위치는 주소가 바뀐 렌더에서 기록한다. 아직 DOM 이 바뀌기 전이라 값이 정확하다.
  // scroll 이벤트로 기록하면 새 화면이 처음에 짧아(로딩) 브라우저가 0 으로 깎은 값이 섞인다.
  const prevKey = useRef(key)
  if (prevKey.current !== key) {
    saved.set(prevKey.current, window.scrollY)
    prevKey.current = key
  }

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  }, [])

  useLayoutEffect(() => {
    if (navType !== 'POP') { window.scrollTo({ top: 0, behavior: 'instant' }); return }
    const y = saved.get(key) ?? 0
    // 목록이 캐시에서 그려진 뒤에 맞춘다. html 의 scroll-behavior: smooth 를 따르면 위에서부터 굴러 내려가므로 instant
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  return null
}
