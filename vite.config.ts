import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  // Relative asset paths: the app is served from a GitHub Pages project
  // subpath (/research-interview-trainer/), and there is no router, so './'
  // is correct at any subpath without hardcoding the repo name.
  base: './',
  plugins: [react()],
});
