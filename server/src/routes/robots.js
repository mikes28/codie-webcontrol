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
import { resolveScanDuration } from '../ble/registry.js';

/**
 * A támogatott Codie-generációk.
 *
 * A BLE kliens a GATT-elrendezésből automatikusan felismeri, melyik generációról
 * van szó (`routing` vagy `no-routing`), de a frontendnek tudnia kell, milyen
 * generációkkal számolhat — ezért a konfiguráció is felsorolja őket.
 */
export const SUPPORTED_VARIANTS = ['routing', 'no-routing'];

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * A robot payload egységesítése — a `variant` mező mindig jelen van
 * (`null`, ha a generáció még ismeretlen, azaz nincs csatlakozva).
 */
function describeRobot(robot) {
  if (!robot) return robot;
  return { ...robot, variant: robot.variant ?? null };
}

export function createRobotRouter({ registry, filters = {}, scripts = null }) {
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
      /** A támogatott Codie-generációk — a frontend ezekre tud alkalmazkodni. */
      variants: SUPPORTED_VARIANTS,
    });
  });

  router.get('/robots', (req, res) => {
    res.json({ robots: registry.list().map(describeRobot) });
  });

  router.get('/robots/:address', (req, res) => {
    const robot = registry.get(req.params.address);
    if (!robot) return res.status(404).json({ error: 'Ismeretlen robot cím.' });
    return res.json(describeRobot(robot));
  });

  /** Robotok keresése a környezetben (a szűrő csak a Codie-kat engedi át). */
  router.post(
    '/scan',
    asyncRoute(async (req, res) => {
      const durationMs = resolveScanDuration(req.body?.durationMs, filters.scanMs ?? 10000);
      const robots = await registry.scan({ durationMs });
      res.json({ robots: robots.map(describeRobot), durationMs });
    }),
  );

  router.post(
    '/robots/:address/connect',
    asyncRoute(async (req, res) => {
      const robot = await registry.connect(req.params.address);
      res.json(describeRobot(robot));
    }),
  );

  router.post(
    '/robots/:address/disconnect',
    asyncRoute(async (req, res) => {
      const robot = await registry.disconnect(req.params.address);
      res.json(describeRobot(robot));
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

  /** A mikrofon figyelésének indítása (a felület szintmérője). */
  router.post(
    '/robots/:address/mic/start',
    asyncRoute(async (req, res) => {
      const robot = registry.startMicStream(req.params.address);
      res.json(describeRobot(robot));
    }),
  );

  /** A mikrofon figyelésének leállítása. */
  router.post(
    '/robots/:address/mic/stop',
    asyncRoute(async (req, res) => {
      const robot = registry.stopMicStream(req.params.address);
      if (!robot) return res.status(404).json({ error: 'Ismeretlen robot cím.' });
      return res.json(describeRobot(robot));
    }),
  );

  // --- robot-scriptek (a weboldal Python kommunikációs scriptje) ---------

  /** A futtatható robot-scriptek listája. */
  router.get(
    '/scripts',
    asyncRoute(async (req, res) => {
      if (!scripts) return res.status(503).json({ error: 'A script-futtatás nincs beállítva.' });
      const items = await scripts.list();
      res.json({ scripts: items });
    }),
  );

  /** A firmware interfész-regisztere — a robot valódi parancsfelülete. */
  router.get(
    '/firmware',
    asyncRoute(async (req, res) => {
      if (!scripts) return res.status(503).json({ error: 'A script-futtatás nincs beállítva.' });
      res.json(await scripts.firmware());
    }),
  );

  /** A futó script állapota egy adott roboton. */
  router.get('/robots/:address/script', (req, res) => {
    const status = scripts ? scripts.status(req.params.address) : null;
    res.json({ address: req.params.address, script: status });
  });

  /** Script indítása: `{ name: "square" }`. */
  router.post(
    '/robots/:address/script',
    asyncRoute(async (req, res) => {
      if (!scripts) return res.status(503).json({ error: 'A script-futtatás nincs beállítva.' });
      const name = String(req.body?.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'A script neve hiányzik.' });
      const started = scripts.start(req.params.address, name);
      res.json(started);
    }),
  );

  /** A futó script leállítása. */
  router.delete('/robots/:address/script', (req, res) => {
    if (!scripts) return res.status(503).json({ error: 'A script-futtatás nincs beállítva.' });
    const stopped = scripts.stop(req.params.address);
    res.json({ address: req.params.address, stopped });
  });

  return router;
}
