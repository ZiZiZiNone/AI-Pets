import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, sep } from 'path';
import fs from 'fs';

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.vrm': 'model/gltf-binary',
  '.vrma': 'model/gltf-binary',
};

function petAssetsPlugin(): Plugin {
  const petsRoot = resolve(__dirname, 'pets') + sep;
  const configRoot = resolve(__dirname, 'config') + sep;

  /**
   * The ids of every package under `pets/`, read from the directory itself.
   *
   * The browser preview has no directory listing of its own, so the roster is published
   * as one small index. It is derived rather than written by hand on purpose: a pet
   * dropped into `pets/` has to appear without anyone editing a list in source.
   */
  const listPetIds = (): string[] => {
    const root = resolve(__dirname, 'pets');
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(resolve(root, name, 'pet.yaml')))
      .sort();
  };

  return {
    name: 'desktop-pet-assets-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url?.split('?')[0] || '';
        if (rawUrl === '/pets/index.json') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(listPetIds()));
          return;
        }
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
              res.setHeader(
                'Content-Type',
                MIME_TYPES[ext] || 'application/octet-stream'
              );
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Malformed URI: fall through to the default handler.
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
      // The bundle mirrors the repository instead of accumulating into it. A package left
      // over from a character that has since been redrawn would otherwise be embedded in
      // the release: the roster would not list it, but the retired art would still ship.
      const mirror = (src: string, dest: string) => {
        fs.rmSync(dest, { recursive: true, force: true });
        copyRecursive(src, dest);
      };
      mirror(resolve(__dirname, 'pets'), resolve(__dirname, 'dist/pets'));
      mirror(resolve(__dirname, 'config'), resolve(__dirname, 'dist/config'));
      fs.writeFileSync(
        resolve(__dirname, 'dist/pets/index.json'),
        JSON.stringify(listPetIds()),
        'utf8'
      );
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
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    clearMocks: true,
  },
});
