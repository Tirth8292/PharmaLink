import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

function getHtmlEntries() {
  const root = __dirname;
  const entryFiles = [
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
      .map((entry) => entry.name),
    ...(existsSync(resolve(root, 'pages'))
      ? readdirSync(resolve(root, 'pages'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => `pages/${entry.name}`)
      : [])
  ];

  return Object.fromEntries(
    entryFiles.map((file) => [
      file.replace(/\.html$/, '').replaceAll('/', '-'),
      resolve(root, file)
    ])
  );
}

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    strictPort: true,
    open: '/login.html'
  },
  preview: {
    port: 3000,
    strictPort: true
  },
  build: {
    rollupOptions: {
      input: getHtmlEntries()
    }
  }
});
