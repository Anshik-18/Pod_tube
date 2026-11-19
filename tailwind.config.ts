import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#09090b",
        surface: {
          DEFAULT: "#111114",
          2: "#17171b",
          3: "#1e1e23",
          4: "#26262c",
        },
        line: {
          DEFAULT: "#232329",
          strong: "#303038",
        },
        ink: {
          DEFAULT: "#f4f4f5",
          muted: "#a1a1aa",
          faint: "#71717a",
        },
        brand: {
          DEFAULT: "#7c5cff",
          hover: "#6b4bf5",
          light: "#a594ff",
        },
        rec: {
          DEFAULT: "#ef4444",
          hover: "#dc2626",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        elevated: "0 24px 48px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        glow: "0 0 0 4px rgba(124, 92, 255, 0.18)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "count-pop": {
          "0%": { opacity: "0", transform: "scale(1.6)" },
          "30%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0.15", transform: "scale(0.9)" },
        },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "scale-in": "scale-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up": "slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-right": "slide-in-right 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        "count-pop": "count-pop 1s ease-out forwards",
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
