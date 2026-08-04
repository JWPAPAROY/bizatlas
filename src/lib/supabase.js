import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 환경변수가 없으면 빌드는 되지만 조회가 전부 실패한다. 화면에서 원인을 알 수 있게 플래그로 노출.
export const isConfigured = Boolean(url && anonKey)

export const supabase = isConfigured
  ? createClient(url, anonKey, { auth: { persistSession: false } })
  : null
