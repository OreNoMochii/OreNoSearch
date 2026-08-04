import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  // Load env from parent directory
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const API_USER = env.API_USER || 'admin';
  const API_PASS = env.API_PASS || 'pass123';

  return {
    // Load .env from the repo root so VITE_* vars (e.g. VITE_MEILI_KEY) are
    // available to client code without duplicating the file into frontend/.
    envDir: path.resolve(__dirname, '..'),
    plugins: [
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
        }
      },
      {
        name: 'ip-whitelist',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const tailscaleIps = (env.TAILSCALE_ALLOWED_IP || '').split(',').map(ip => ip.trim()).filter(Boolean);
            const allowedIps = [
              '127.0.0.1',
              '::1',
              '192.168.0.41',
              '192.168.0.108',
              '192.168.0.53',
              '192.168.0.26',
              '192.168.0.6',
              '192.168.0.3',
              '192.168.0.217',
              ...tailscaleIps
            ];

            const remoteAddr = req.socket.remoteAddress || '';
            // Normalize IP: strip IPv6 prefix (::ffff:) if present to get the raw IPv4
            const cleanIp = remoteAddr.replace(/^.*:/, '');

            const isAllowed = allowedIps.includes(cleanIp) ||
              allowedIps.some(ip => remoteAddr.includes(ip));

            if (!isAllowed) {
              console.warn(`Blocked unauthorized access attempt from: ${remoteAddr} (Cleaned: ${cleanIp})`);
              res.statusCode = 403;
              res.end('<h1>403 Forbidden</h1><p>Access denied: Your IP is not whitelisted.</p>');
              return;
            }
            next();
          });
        }
      }
    ],
    server: {
      host: '0.0.0.0',
      https: {
        key: fs.readFileSync(path.resolve(__dirname, '../search-ui/certs/key.pem')),
        cert: fs.readFileSync(path.resolve(__dirname, '../search-ui/certs/cert.pem')),
      },
      proxy: {
        '/meilisearch': {
          target: 'http://127.0.0.1:7705',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/meilisearch/, '')
        },
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '/api') // Keep /api prefix for the backend
        }
      }
    }
  };
});
