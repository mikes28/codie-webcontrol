/**
 * REST API — a robotok felderítése, kapcsolatok és parancsok.
 *
 * Minden végpont a `RobotRegistry`-n keresztül dolgozik, így a HTTP és a
 * socket.io felület ugyanazt a viselkedést ad (a socket a registry eseményeit
 * továbbítja, a parancsokat ugyanaz a `runCommand` hajtja végre).
 */

'use strict';

import { Router } from 'express';

import { COMMAND_NAMES } from '../commands.js';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createRobotRouter({ registry, filters = {} }) {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, robots: registry.list().length });
  });

  /** A szűrő beállításai (a UI és a scriptek ezeket mutatják meg). */
  router.get('/config', (req, res) => {
    res.json({
      nameFilter: filters.nameFilter ?? null,
      serviceUuids: filters.serviceUuids ?? [],
      macAllowlist: filters.macAllowlist ?? [],
      macOnly: Boolean(filters.macOnly),
      commands: COMMAND_NAMES,
    });
  });

  router.get('/robots', (req, res) => {
    res.json({ robots: registry.list() });
  });

  router.get('/robots/:address', (req, res) => {
    const robot = registry.get(req.params.address);
    if (!robot) return res.status(404).json({ error: 'Ismeretlen robot cím.' });
    return res.json(robot);
  });

  /** Robotok keresése a környezetben (a szűrő csak a Codie-kat engedi át). */
  router.post(
    '/scan',
    asyncRoute(async (req, res) => {
      const durationMs = Math.min(
        Math.max(Number(req.body?.durationMs ?? filters.scanMs ?? 10000), 1000),
        120000,
      );
      const robots = await registry.scan({ durationMs });
      res.json({ robots, durationMs });
    }),
  );

  router.post(
    '/robots/:address/connect',
    asyncRoute(async (req, res) => {
      const robot = await registry.connect(req.params.address);
      res.json(robot);
    }),
  );

  router.post(
    '/robots/:address/disconnect',
    asyncRoute(async (req, res) => {
      const robot = await registry.disconnect(req.params.address);
      res.json(robot);
    }),
  );

  /** Magas szintű parancs: { name: 'led', params: { color: 'red' } } */
  router.post(
    '/robots/:address/command',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.name ?? '');
      const params = req.body?.params ?? {};
      const result = await registry.command(req.params.address, name, params);
      res.json({ address: registry.get(req.params.address)?.address, ...result });
    }),
  );

  router.get('/robots/:address/telemetry', (req, res) => {
    const robot = registry.get(req.params.address);
    if (!robot) return res.status(404).json({ error: 'Ismeretlen robot cím.' });
    return res.json({ address: robot.address, telemetry: robot.telemetry });
  });

  return router;
}
