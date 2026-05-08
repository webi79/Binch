/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        brand: {
          limeLight: "#B6F44A",
          lime: "#7FEA4D",
          limePressed: "#3ED35A",
          green: "#7FEA4D",
          dark: "#1A1A1A",
          gray: "#5E5E5E",
        },
      },
    },
  },
  plugins: [],
};
