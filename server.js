'use strict';

/**
 * Atomis Directory Service
 *
 * The one URL compiled into the mobile app. Its entire job is to answer
 * "which deployment does this person belong to?" — it never sees credentials
 * and holds no customer data beyond the routing table.
 *
 * It answers WHERE. The tenant's own dashboard answers WHO.
 *
 * Deploy as its own project. It must not share a database with any tenant —
 * it has no database at all. Keep it boring; every first-time login in the
 * fleet depends on it being up.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { loadManifest } = require('./lib/manifest');

const STARTED_AT = new Date().toISOString();

function log(fields) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
}

/**
 * Never log a full email address. The domain is the part that routes; the
 * local part is personal information with no operational value here.
 */
function emailDomain(value) {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at === -1) return null;
  const domain = value.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

function normaliseCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return code || null;
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function lookup(manifest, { code, email }) {
  const c = normaliseCode(code);
  if (c) return manifest.byCode.get(c) || null;
  const domain = emailDomain(email);
  if (domain) return manifest.byDomain.get(domain) || null;
  return null;
}

/**
 * Only ever expose what the app needs to route and render. Never the Railway
 * project id, the pinned version, or anything about any other customer.
 */
function publicView(customer) {
  return {
    tenantId: customer.tenantId,
    apiBaseUrl: customer.apiBaseUrl,
    modules: customer.modules,
    branding: customer.branding,
    features: customer.features,
  };
}

function createApp({ manifest, fleetKey, rateLimitMax } = {}) {
  const app = express();
  const heartbeats = new Map();

  app.use(express.json({ limit: '16kb' }));
  app.set('trust proxy', 1); // sits behind a platform proxy
  app.disable('x-powered-by');

  // The launcher calls /resolve from a different origin in every delivery mode:
  // capacitor://localhost inside the app, a static host as a PWA, localhost in
  // development. Without CORS the browser blocks all of it.
  //
  // Allowing any origin is safe here and only here: /resolve is public,
  // unauthenticated routing data and sets no cookies, so there is no ambient
  // authority for another site to borrow. The fleet endpoints deliberately get
  // no CORS at all — they carry a shared secret and must never be reachable
  // from a web page.
  //
  // Mounted before the rate limiter so a preflight doesn't spend a request.
  app.use('/resolve', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      return res.status(204).end();
    }
    return next();
  });

  // /resolve runs before login, so it cannot be authenticated. That makes it
  // an enumeration surface: rate limit it, and return an identical generic 404
  // for "no such company" and "company suspended" alike.
  //
  // The default is deliberately not tight. A whole depot behind one NAT shares
  // an IP, and locking out a crew at 5am is worse than a slow enumeration.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: rateLimitMax || Number(process.env.RATE_LIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      log({ evt: 'resolve', outcome: 'rate_limited', method: req.method });
      res.status(429).json({ error: 'too_many_requests' });
    },
  });
  app.use('/resolve', limiter);

  function handleResolve(req, res) {
    const src = req.method === 'POST' ? req.body || {} : req.query;
    const { code, email } = src;

    if (!code && !email) {
      log({ evt: 'resolve', outcome: 'bad_request', method: req.method });
      return res.status(400).json({ error: 'provide code or email' });
    }

    const via = code ? 'code' : 'email';
    const customer = lookup(manifest, { code, email });

    if (!customer || customer.status !== 'active') {
      // Deliberately identical for unknown and suspended: same status, same
      // body, same headers. Nothing below this line may differentiate them.
      log({
        evt: 'resolve',
        outcome: 'not_found',
        via,
        code: via === 'code' ? normaliseCode(code) : undefined,
        domain: via === 'email' ? emailDomain(email) : undefined,
      });
      return res.status(404).json({ error: 'not_found' });
    }

    if (via === 'email' || req.method === 'POST') {
      // The request URL contains an email address. Never let a shared cache
      // store a response keyed on personal information.
      res.set('Cache-Control', 'private, no-store');
    } else {
      // Resolution by code is stable but not immutable — let devices cache it,
      // but not forever, so a migration propagates without an app update.
      res.set('Cache-Control', 'public, max-age=3600');
    }

    log({
      evt: 'resolve',
      outcome: 'ok',
      via,
      tenantId: customer.tenantId,
      code: via === 'code' ? normaliseCode(code) : undefined,
      domain: via === 'email' ? emailDomain(email) : undefined,
    });
    return res.json(publicView(customer));
  }

  app.get('/resolve', handleResolve);
  // POST keeps the email out of the URL entirely, for clients that prefer it.
  app.post('/resolve', handleResolve);

  // -------------------------------------------------------------------------
  // Fleet registry — each tenant deployment heartbeats here on boot and on a
  // timer, giving you one place to see what every customer is running.
  // -------------------------------------------------------------------------

  function requireFleetKey(req, res) {
    if (!fleetKey) {
      log({ evt: 'fleet', outcome: 'unconfigured', path: req.path });
      res.status(503).json({ error: 'fleet_key_not_configured' });
      return false;
    }
    if (!secretsMatch(req.get('x-fleet-key'), fleetKey)) {
      log({ evt: 'fleet', outcome: 'unauthorized', path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  app.post('/heartbeat', (req, res) => {
    if (!requireFleetKey(req, res)) return;
    const { tenantId, version, healthy } = req.body || {};
    if (typeof tenantId !== 'string' || !manifest.byTenantId.has(tenantId)) {
      return res.status(404).json({ error: 'unknown tenant' });
    }
    heartbeats.set(tenantId, {
      version: typeof version === 'string' ? version : null,
      healthy: healthy !== false,
      at: new Date().toISOString(),
    });
    log({ evt: 'heartbeat', tenantId, version, healthy: healthy !== false });
    return res.json({ ok: true });
  });

  app.get('/fleet', (req, res) => {
    if (!requireFleetKey(req, res)) return;
    return res.json({
      // Heartbeats are held in memory, so they are empty after a restart.
      // Reporting when this process started is what stops "no heartbeat" being
      // read as "that tenant is down" when the directory simply redeployed.
      directoryStartedAt: STARTED_AT,
      manifestLoadedAt: manifest.loadedAt,
      customers: manifest.customers.map((c) => ({
        tenantId: c.tenantId,
        displayName: c.displayName,
        status: c.status,
        modules: c.modules,
        pinnedCoreVersion: c.pinnedCoreVersion ?? null,
        lastHeartbeat: heartbeats.get(c.tenantId) || null,
      })),
    });
  });

  app.get('/health', (_req, res) =>
    res.json({ ok: true, customers: manifest.byTenantId.size, startedAt: STARTED_AT })
  );

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}

function start() {
  const port = Number(process.env.PORT || 3000);
  const file = process.env.MANIFEST_PATH || path.join(__dirname, 'customers.yml');

  let manifest;
  try {
    manifest = loadManifest({ file });
  } catch (err) {
    // Refusing to boot is the point. A manifest that would misroute a customer
    // must never reach production.
    log({ evt: 'boot', outcome: 'manifest_invalid', error: err.message });
    process.exit(1);
  }

  const fleetKey = process.env.FLEET_KEY || '';
  if (!fleetKey) {
    log({ evt: 'boot', level: 'warn', msg: 'FLEET_KEY unset — /fleet and /heartbeat disabled' });
  }

  const app = createApp({ manifest, fleetKey });

  app.listen(port, () => {
    log({
      evt: 'boot',
      outcome: 'listening',
      port,
      allowedHostSuffix: manifest.allowedHostSuffix,
      customers: manifest.byTenantId.size,
      codes: manifest.byCode.size,
      emailDomains: manifest.byDomain.size,
    });
  });
}

if (require.main === module) start();

module.exports = { createApp, publicView, emailDomain, lookup };
