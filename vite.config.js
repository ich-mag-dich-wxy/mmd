import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'path';

export default defineConfig({
  plugins: [wasm()],
  // MPA 模式：index.html（控制面板）+ viewer.html（模型窗口）
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,  // 端口被占用时直接失败，避免 electron 探测到错误端口
    open: false,  // Electron 自己打开窗口，不需要 vite 自动开浏览器
    host: true,
  },
  optimizeDeps: {
    exclude: ['mmd-mpl'],
  },
});
