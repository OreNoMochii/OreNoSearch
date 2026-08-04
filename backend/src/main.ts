import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { logDebug } from './utils/logger';
import { OutreachController } from './controllers/OutreachController';

import path_mod from 'path';

dotenv.config({ path: path_mod.resolve(__dirname, '../../.env') }); // Adjust relative path based on context

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- Logging Middleware ---
app.use((req, res, next) => {
    const start = Date.now();
    const { method, path } = req;
    const remoteAddr = req.socket.remoteAddress || '';
    const cleanIp = remoteAddr.replace(/^.*:/, '');
    const origin = req.get('origin') || 'no-origin';

    res.on('finish', async () => {
        if (path === '/api/queue-status') return; // Silence polling logs
        const duration = Date.now() - start;
        const status = res.statusCode;
        const logMsg = `[REQUEST] ${method} ${path} | Status: ${status} | IP: ${cleanIp} | Origin: ${origin} | Duration: ${duration}ms`;
        logDebug(logMsg);
    });
    next();
});

// --- Basic Authentication Middleware ---
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    const API_USER = process.env.API_USER || 'admin';
    const API_PASS = process.env.API_PASS || 'pass123';

    const auth = { login: API_USER, password: API_PASS };
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && password && login === auth.login && password === auth.password) {
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="Metaview API"');
    res.status(401).send('Authentication required.');
});

import { SearchController } from './controllers/SearchController';

// --- Routes ---
app.post('/api/outreach', OutreachController.triggerOutreach);
app.get('/api/queue-status', OutreachController.getQueueStatus);
app.post('/api/search', SearchController.runSearch);
app.get('/api/locations', SearchController.getLocations);

// --- Server Init ---
const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, '127.0.0.1', () => {
    logDebug(`Server running on port ${PORT}`);
    console.log(`Server running on port ${PORT}`);
});
