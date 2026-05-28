// Keep PostCSS config as CommonJS — Vite reads it before its ESM loader
// kicks in, and the PostCSS plugins themselves remain CJS for now.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
