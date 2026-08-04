import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages 프로젝트 페이지는 /<repo>/ 하위에 배포된다.
// 커스텀 도메인을 붙이면 BASE_PATH=/ 로 덮어쓴다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.BASE_PATH || '/bizatlas/',
})
