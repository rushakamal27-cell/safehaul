/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Primary palette
        "bg":           "#081018",
        "bg-secondary": "#101922",
        "card":         "#121D27",
        "card-hover":   "#16222F",
        "border-color": "#22313D",
        "blue":         "#14B8FF",
        "green":        "#16D975",
        "warning":      "#FFB547",
        "red":          "#FF4A4A",
        // Legacy (keep tailwind classes working on old refs)
        "bg-deep":  "#081018",
        "bg-panel": "#101922",
        "bg-card":  "#121D27",
        "cyan":     "#14B8FF",
        "orange":   "#FFB547",
        "yellow":   "#FFB547",
      },
      fontFamily: {
        sans:    ["Inter", "system-ui", "sans-serif"],
        mono:    ['"JetBrains Mono"', "monospace"],
        display: ["Inter", "system-ui", "sans-serif"],
        ui:      ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        "2xl": "16px",
        "3xl": "20px",
        "4xl": "24px",
      },
    },
  },
  plugins: [],
};
