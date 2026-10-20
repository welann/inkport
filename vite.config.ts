import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  const embedded = mode === 'embedded'
  const standalone = mode === 'standalone' || embedded
  return {
    base: standalone ? './' : '/',
    define: {
      __STANDALONE__: JSON.stringify(standalone),
      __EMBEDDED__: JSON.stringify(embedded),
    },
    server: {
      port: 5173,
      proxy: { '/d': 'http://127.0.0.1:8787' },
    },
    build: {
      target: 'es2022',
      outDir: embedded ? 'dist-embedded' : standalone ? 'dist-standalone' : 'dist',
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: standalone ? { output: { inlineDynamicImports: true } } : undefined,
    },
  }
})
