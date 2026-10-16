import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, sep } from 'path';
import fs from 'fs';

function petAssetsPlugin(): Plugin {
  const mimeMap: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.yaml': 'text/yaml; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.json': 'image/json; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.vrm': 'model/gltf-binary',
    '.vrma': 'model/gltf-binary',
  };

  const petsRoot = resolve(__dirname, 'pets') + sep;
  const configRoot = resolve(__dirname, 'config') + sep;

  return {
    name: 'desktop-pet-assets-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url?.split('?')[0] || '';
        if (rawUrl.startsWith('/pets/') || rawUrl.startsWith('/config/')) {
          try {
            const decoded = decodeURIComponent(rawUrl);
            const filePath = resolve(__dirname, '.' + decoded);
            if (
              (filePath.startsWith(petsRoot) || filePath.startsWith(configRoot)) &&
              fs.existsSync(filePath) &&
              fs.statSync(filePath).isFile()
            ) {
              const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
              res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Fall through on malformed URI
          }
        }
        next();
      });
    },
    closeBundle() {
      const copyRecursive = (src: string, dest: string) => {
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = resolve(src, entry.name);
          const destPath = resolve(dest, entry.name);
          if (entry.isDirectory()) copyRecursive(srcPath, destPath);
          else fs.copyFileSync(srcPath, destPath);
        }
      };
      copyRecursive(resolve(__dirname, 'pets'), resolve(__dirname, 'dist/pets'));
      copyRecursive(resolve(__dirname, 'config'), resolve(__dirname, 'dist/config'));
    },
  };
}

export default defineConfig({
  plugins: [vue(), petAssetsPlugin()],
  clearScreen: false,
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: ['es2021', 'chrome105', 'safari15'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        companion: resolve(__dirname, 'companion.html'),
        hud: resolve(__dirname, 'hud.html'),
      },
    },
  },
});
