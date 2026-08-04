import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase, isConfigured } from './supabase'

const MAX_COMPARE = 3
const STORAGE_KEY = 'bizatlas.compare'

const Ctx = createContext(null)

export function StoreProvider({ children }) {
  const [taxonomy, setTaxonomy] = useState({})
  const [loading, setLoading] = useState(true)
  const [compare, setCompare] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [] } catch { return [] }
  })

  // 통제 어휘는 앱 전체에서 라벨 변환에 쓰이므로 최초 1회만 받아 캐시한다.
  useEffect(() => {
    if (!isConfigured) { setLoading(false); return }
    supabase
      .from('taxonomy')
      .select('kind, value, label_ko, description, sort_order')
      .order('sort_order')
      .then(({ data }) => {
        const grouped = {}
        for (const t of data ?? []) (grouped[t.kind] ??= []).push(t)
        setTaxonomy(grouped)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compare))
  }, [compare])

  const toggleCompare = useCallback((biz) => {
    setCompare((prev) => {
      if (prev.some((b) => b.id === biz.id)) return prev.filter((b) => b.id !== biz.id)
      if (prev.length >= MAX_COMPARE) return prev
      return [...prev, { id: biz.id, slug: biz.slug, name: biz.name }]
    })
  }, [])

  const clearCompare = useCallback(() => setCompare([]), [])

  const labelOf = useCallback(
    (kind, value) =>
      taxonomy[kind]?.find((t) => t.value === value)?.label_ko ?? value ?? '',
    [taxonomy],
  )

  // 태그가 무슨 뜻인지 화면에서 설명하기 위한 것. 모든 통제 어휘에 설명이 채워져 있다.
  const descOf = useCallback(
    (kind, value) => taxonomy[kind]?.find((t) => t.value === value)?.description ?? '',
    [taxonomy],
  )

  const value = useMemo(
    () => ({ taxonomy, labelOf, descOf, loading, compare, toggleCompare, clearCompare, MAX_COMPARE }),
    [taxonomy, labelOf, descOf, loading, compare, toggleCompare, clearCompare],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
