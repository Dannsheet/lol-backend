import express from 'express';
import cors from 'cors';

import meRoutes from './routes/me.js';
import depositsRoutes from './routes/deposits.js';
import withdrawalsRoutes from './routes/withdrawals.js';
import securityRoutes from './routes/security.js';
import walletRoutes from './routes/wallet.js';
import referralRoutes from './routes/referrals.routes.js';
import vipRoutes from './routes/vip.routes.js';
import videosRoutes from './routes/videos.js';
import cuentaRoutes from './routes/cuenta.js';
import suscripcionRoutes from './routes/suscripcion.js';
import tatumWebhook from './webhooks/tatum.webhook.js';

const app = express();

// Middleware globales
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ← NECESARIO para POST con body

// Rutas principales
app.use('/api', meRoutes);
app.use('/api', depositsRoutes);
app.use('/api', withdrawalsRoutes);
app.use('/api', securityRoutes);
app.use('/api', walletRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/vip', vipRoutes);
app.use('/api', videosRoutes);
app.use('/api', cuentaRoutes);
app.use('/api', suscripcionRoutes);

// Webhooks
app.use('/webhooks', tatumWebhook);

export default app;
