import type { Config } from "tailwindcss";

// Design tokens live here and are loaded by the `@config` directive in src/index.css.
export default {
  theme: {
    extend: {
      colors: {
        board: {
          bg: "#0f1117",
          panel: "#171a23",
          border: "#262a36",
          text: "#e6e6e6",
          muted: "#8b90a0",
          accent: "#7aa2f7",
        },
      },
    },
  },
} satisfies Config;
