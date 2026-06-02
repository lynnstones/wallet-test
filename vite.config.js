import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    // host: true, // 局域网访问时取消注释
  },
  build: {
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['chart.js', 'chartjs-plugin-datalabels'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
})
