import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `npm run dev:api` serves the Worker on 8787; this proxies /api to it.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
