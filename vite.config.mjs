import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/");
          if (normalized.includes("/node_modules/@supabase/")) return "cloud-client";
          if (normalized.includes("/node_modules/@phosphor-icons/")) return "reader-icons";
          if (mode !== "admin" && normalized.includes("/node_modules/fflate/")) {
            return "document-import";
          }
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(normalized)) {
            return "react-vendor";
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
}));
