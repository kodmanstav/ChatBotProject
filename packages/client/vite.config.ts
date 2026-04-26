import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
   const env = loadEnv(mode, __dirname, '');
   const apiProxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

   return {
      plugins: [react(), tailwindcss()],
      resolve: {
         alias: {
            '@': path.resolve(__dirname, './src'),
         },
      },
      server: {
         host: true,
         proxy: {
            '/api': apiProxyTarget,
         },
      },
   };
});
