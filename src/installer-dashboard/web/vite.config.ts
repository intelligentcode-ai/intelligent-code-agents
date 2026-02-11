import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "../../../dist/installer-dashboard/web-build"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
