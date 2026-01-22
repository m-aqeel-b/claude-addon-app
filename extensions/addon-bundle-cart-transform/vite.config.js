import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "./src/run.ts",
      formats: ["es"],
      fileName: "function",
    },
    rollupOptions: {
      external: ["@shopify/shopify_function"],
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
