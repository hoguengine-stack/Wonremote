import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: mode === 'development' ? '/' : './',
    server: { port: 3001, host: '0.0.0.0' },
    plugins: [react()],
    define: {
      'process.env.WONREMOTE_SERVER_URL': JSON.stringify(env.VITE_WONREMOTE_SERVER_URL || '')
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') }
    },
    build: {
      sourcemap: false
    }
  };
});
