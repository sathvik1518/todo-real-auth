import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two ways to reach the API (see .env.development and .env.cors):
//   npm run dev       the page asks /api/... on ITS OWN address, and this proxy forwards it to the backend. Same origin: no CORS.
//   npm run dev:cors  the page asks http://localhost:8000/api/... directly. Different origin: the browser checks CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // the backend only allows the page from port 5173
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: false } },
  },
  preview: { port: 5173, strictPort: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
