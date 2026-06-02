/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx,html}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#f0f2f8',
        card:       'rgba(255,255,255,0.72)',
        accent:     '#007aff',
        accentSoft: '#e5f0ff',
      },
      boxShadow: {
        soft:  '0 4px 24px rgba(99,102,241,0.07), 0 1.5px 6px rgba(0,0,0,0.04)',
        glass: '0 8px 32px rgba(99,102,241,0.10), 0 1.5px 6px rgba(0,0,0,0.04)',
      },
    },
  },
  plugins: [],
}
