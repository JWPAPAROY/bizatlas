import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { GitCompare, X } from 'lucide-react'
import { useStore } from '../lib/store.jsx'

// 탐색 중에도 무엇을 담았는지 보이도록 화면 아래에 붙는 비교 바. 헤더 배지 숫자만으로는
// 무엇이 담겼는지 알 수 없고, 꽉 찼을 때 + 버튼이 왜 안 먹는지도 알 수 없었다.
export default function CompareBar() {
  const { compare, toggleCompare, clearCompare, compareFullAt, MAX_COMPARE } = useStore()
  const { pathname } = useLocation()
  const [warn, setWarn] = useState(false)

  useEffect(() => {
    if (!compareFullAt) return
    setWarn(true)
    const t = setTimeout(() => setWarn(false), 2500)
    return () => clearTimeout(t)
  }, [compareFullAt])

  if (!compare.length || pathname === '/compare') return null

  return (
    <>
      {/* 바가 푸터를 가리지 않도록 같은 높이만큼 자리를 둔다 */}
      <div className="h-16" aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white/95 shadow-[0_-4px_12px_rgba(15,23,42,0.06)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {warn ? (
              <span className="text-sm font-medium text-amber-700">
                비교는 최대 {MAX_COMPARE}개까지입니다 — 하나를 빼고 담아 주세요
              </span>
            ) : (
              compare.map((b) => (
                <span
                  key={b.id}
                  className="inline-flex max-w-[10rem] items-center gap-1 rounded-full bg-ink-100 py-1 pr-1.5 pl-2.5 text-xs font-medium text-ink-700"
                >
                  <span className="truncate">{b.name}</span>
                  <button
                    type="button"
                    onClick={() => toggleCompare(b)}
                    className="shrink-0 rounded-full text-ink-400 hover:text-rose-500"
                    aria-label={`${b.name} 비교에서 제외`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={clearCompare}
            className="hidden shrink-0 text-xs text-ink-500 hover:text-ink-800 sm:block"
          >
            비우기
          </button>
          <Link
            to="/compare"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <GitCompare size={15} />
            비교하기 {compare.length}/{MAX_COMPARE}
        </Link>
      </div>
    </div>
    </>
  )
}
