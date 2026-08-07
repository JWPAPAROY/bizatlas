import { HashRouter, Routes, Route, Link, NavLink } from 'react-router-dom'
import { Map, GitCompare, Info, Activity } from 'lucide-react'
import { StoreProvider, useStore } from './lib/store.jsx'
import Home from './pages/Home.jsx'
import Detail from './pages/Detail.jsx'
import Compare from './pages/Compare.jsx'
import About from './pages/About.jsx'
import Today from './pages/Today.jsx'

// GitHub Pages 는 SPA 라우팅에 404 가 나므로 HashRouter 를 쓴다 (404.html 트릭 불필요).

function Header() {
  const { compare } = useStore()
  const navCls = ({ isActive }) =>
    `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-ink-100'
    }`

  return (
    <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
            <Map size={18} />
          </span>
          <span className="text-lg font-bold tracking-tight">BizAtlas</span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink to="/" className={navCls} end>
            탐색
          </NavLink>
          <NavLink to="/today" className={navCls}>
            <Activity size={15} />
            오늘
          </NavLink>
          <NavLink to="/compare" className={navCls}>
            <GitCompare size={15} />
            비교
            {compare.length > 0 && (
              <span className="ml-0.5 rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">
                {compare.length}
              </span>
            )}
          </NavLink>
          <NavLink to="/about" className={navCls}>
            <Info size={15} />
            소개
          </NavLink>
        </nav>
      </div>
    </header>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <HashRouter>
        <div className="flex min-h-screen flex-col">
          <Header />
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/today" element={<Today />} />
              <Route path="/b/:slug" element={<Detail />} />
              <Route path="/compare" element={<Compare />} />
              <Route path="/about" element={<About />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </main>
          <footer className="border-t border-ink-200 py-6 text-center text-sm text-ink-500">
            BizAtlas — 전세계 비즈니스 모델을 같은 축으로 비교합니다. 매일 자동 갱신.
          </footer>
        </div>
      </HashRouter>
    </StoreProvider>
  )
}
