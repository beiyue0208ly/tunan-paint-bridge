import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue()
  ],
  build: {
    target: 'es2020',
    minify: false,
    outDir: 'dist/webview',
    emptyOutDir: true
  },
  base: './'
})
