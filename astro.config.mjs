import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://sale.fightscience.com',
  output: 'static',
  adapter: vercel(),
});
