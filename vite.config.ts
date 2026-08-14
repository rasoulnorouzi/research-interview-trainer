import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig({
  // Relative asset paths: the app is served from a GitHub Pages project
  // subpath (/research-interview-trainer/), and there is no router, so './'
  // is correct at any subpath without hardcoding the repo name. Also load-
  // bearing for the second entry point below: admin.html gets the same
  // relative asset paths for the same reason.
  base: './',
  plugins: [react()],
  build: {
    rollupOptions: {
      // Two HTML entry points sharing this one config: the student app and
      // the instructor dashboard (admin.html / admin/*, BACKEND-PLAN.md §7).
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
});
