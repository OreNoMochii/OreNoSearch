import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { isIP } from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  // Load env from parent directory
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const API_USER = env.API_USER || 'admin';
  const API_PASS = env.API_PASS || 'pass123';

  // Load the dev TLS pair only if both files exist. Missing certs must
  // degrade to plain HTTP for `vite dev`, never fail `vite build`.
  const certDir = path.resolve(__dirname, '../../certs');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  const devCerts =
    fs.existsSync(keyPath) && fs.existsSync(certPath)
      ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
      : undefined;

  return {
    // Load .env from the repo root so VITE_* vars (e.g. VITE_MEILI_KEY) are
    // available to client code without duplicating the file into frontend/.
    envDir: path.resolve(__dirname, '../..'),
    plugins: [
      tailwindcss(),
      react(),
      {
        name: 'basic-auth',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            // Bypass OPTIONS and endpoints that handle their own auth
            if (req.method === 'OPTIONS') return next();
            if (req.url && req.url.startsWith('/meilisearch')) return next();

            const authHeader = req.headers.authorization || '';
            if (authHeader.startsWith('Basic ')) {
              const b64 = authHeader.split(' ')[1];
              const decoded = Buffer.from(b64, 'base64').toString();
              const [user, pass] = decoded.split(':');

              if (user === API_USER && pass === API_PASS) {
                return next();
              }
            }

            res.statusCode = 401;
            res.setHeader('WWW-Authenticate', 'Basic realm="Metaview Scraper"');
            res.end('Authentication required.');
          });
        },
      },
      {
        name: 'ip-whitelist',
        configureServer(server) {
          // B5: the previous check fell back to `remoteAddr.includes(ip)`, a
          // substring match. '192.168.0.3' therefore admitted 192.168.0.30
          // through .39, and '::1' admitted any IPv6 address containing '::1'
          // (e.g. 2001:db8::1234). The old normaliser was also greedy —
          // `replace(/^.*:/, '')` reduced a real IPv6 address to its last group.
          //
          // Addresses now come from DEV_ALLOWED_IPS rather than being hardcoded.
          const allowed = new Set(
            ['127.0.0.1', '::1', ...(env.DEV_ALLOWED_IPS || '').split(',')]
              .map((ip) => ip.trim())
              .filter(Boolean),
          );

          /** Unwraps ::ffff:1.2.3.4 to 1.2.3.4; leaves genuine IPv6 intact. */
          const normalise = (remote: string): string | null => {
            if (!remote) return null;
            const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(remote);
            const candidate = mapped ? mapped[1] : remote;
            return isIP(candidate) ? candidate : null;
          };

          server.middlewares.use((req, res, next) => {
            const remoteAddr = req.socket.remoteAddress || '';
            const ip = normalise(remoteAddr);

            if (ip !== null && allowed.has(ip)) return next(); // exact match only

            console.warn(`[ip-whitelist] blocked ${remoteAddr}`);
            res.statusCode = 403;
            res.end('<h1>403 Forbidden</h1><p>Access denied: your IP is not allowed.</p>');
          });
        },
      },
    ],
    build: {
      target: 'es2022',
      sourcemap: 'hidden', // uploaded to error tracking, not served
      cssCodeSplit: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 500,
    },
    esbuild: false,
    // NOTE: no esbuild.drop/pure here — Vite 8 bundles with rolldown, which
    // does not expose those options. console.error is retained deliberately
    // so runtime diagnostics still surface in production.
    server: {
      host: '0.0.0.0',
      // B36: these are dev-only self-signed certs, but the reads ran at
      // config-load time — so `vite build` failed anywhere they were absent
      // (a container image, CI, a fresh clone). Production terminates TLS at
      // nginx or the ingress and never needs them, so HTTPS is now enabled
      // only when the pair is actually on disk.
      https: devCerts,
      proxy: {
        '/meilisearch': {
          target: 'http://127.0.0.1:7705',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/meilisearch/, ''),
        },
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '/api'), // Keep /api prefix for the backend
        },
      },
    },
  };
});
