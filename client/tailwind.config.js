/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: '#12162b',
        panelSoft: '#1b2342',
        ink: '#e8eefc',
        muted: '#8b98c8',
        neon: '#2ce5b5',
        electric: '#5f7cff',
      },
      boxShadow: {
        glow: '0 10px 40px rgba(44, 229, 181, 0.18)',
      },
      fontFamily: {
        sans: ['Outfit', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

