import { defineConfig } from "vite";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  root: ".",
  publicDir: "public",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

