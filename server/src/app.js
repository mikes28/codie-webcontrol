/**
 * Express alkalmazás — a REST API + a statikus frontend kiszolgálása.
 *
 * A `registry` injektált, így a tesztek hamis registry-vel is futtathatják
 * az alkalmazás BLE-hardware nélkül.
 */

'use strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createRobotRouter } from './routes/robots.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const publicDir = path.join(here, '..', 'public');

export function createApp({ registry, filters = {} }) {
  const app = express();

  app.use(express.json());
  app.use('/api', createRobotRouter({ registry, filters }));
  app.use(express.static(publicDir));

  // eslint-disable-next-line no-unused-vars -- Express a 4 argumentum alapján ismeri
  app.use((error, req, res, next) => {
    // A validációs hibák 400-as státusszal jönnek (a parancsréteg jelöli őket),
    // a BLE-hibák 503-zal, minden más (programozási hiba) 500.
    const status = error.status || 500;
    if (status >= 500) console.error('[api]', error);
    res.status(status).json({ error: error.message || 'Ismeretlen hiba.' });
  });

  return app;
}
