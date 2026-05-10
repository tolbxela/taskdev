import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://taskdev.dev',
  integrations: [sitemap()],
  build: { assets: 'assets' }
});
