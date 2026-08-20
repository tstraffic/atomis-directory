'use strict';

/**
 * Manifest loading and validation.
 *
 * customers.yml is the fleet's source of truth: who exists, what codes and
 * email domains reach them, and which deployment they live on. A malformed
 * entry here routes one company's crews at another company's database, so
 * every problem is a hard failure at boot (and in CI via `npm run validate`),
 * never a warning.
 */

const fs = require('fs');
const yaml = require('js-yaml');

// The leading dot is load-bearing. Without it "evil-atomis.com.au" passes the
// suffix check, and the app would happily POST credentials to it.
const DEFAULT_ALLOWED_HOST_SUFFIX = '.atomis.com.au';

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
const STATUSES = new Set(['active', 'suspended']);

// The Atomis apps a customer can be entitled to. Keep in step with apps.json
// in the atomis-app repo — these keys are what each app checks itself against.
const KNOWN_APPS = new Set(['control_room', 'field_station']);

class ManifestError extends Error {
  constructor(problems) {
    super(`customers.yml is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ManifestError';
    this.problems = problems;
  }
}

/**
 * Defence in depth. The device enforces this too (see the app's
 * assertTrustedHost), but a manifest that would point the fleet off-domain
 * must never get past boot here either.
 */
function checkUrl(rawUrl, suffix) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return { ok: false, reason: 'apiBaseUrl is missing' };
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `apiBaseUrl is not a valid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `apiBaseUrl must be https: ${rawUrl}` };
  }
  // https://attacker@ts.atomis.com.au and friends — the hostname check would
  // pass, but the URL is not what it appears to be.
  if (url.username || url.password) {
    return { ok: false, reason: `apiBaseUrl must not embed credentials: ${rawUrl}` };
  }
  if (!url.hostname.endsWith(suffix)) {
    return {
      ok: false,
      reason: `apiBaseUrl host must end with ${suffix}: ${url.hostname}`,
    };
  }
  // Normalise to the origin so a stray path in the manifest can't leak into
  // what the app treats as its base URL.
  return { ok: true, origin: url.origin };
}

function validateAndIndex(doc, suffix) {
  const problems = [];
  const byCode = new Map();
  const byDomain = new Map();
  const byTenantId = new Map();
  const customers = [];

  if (!doc || typeof doc !== 'object') {
    throw new ManifestError(['file is empty or not a YAML mapping']);
  }
  if (!Array.isArray(doc.customers)) {
    throw new ManifestError(['top-level "customers" must be a list']);
  }
  if (doc.customers.length === 0) {
    throw new ManifestError(['"customers" is empty — at least one entry is required']);
  }

  doc.customers.forEach((c, i) => {
    const at = `customers[${i}]`;
    if (!c || typeof c !== 'object') {
      problems.push(`${at} is not a mapping`);
      return;
    }

    const id = c.tenantId;
    const label = typeof id === 'string' && id ? id : at;

    if (typeof id !== 'string' || !TENANT_ID_RE.test(id)) {
      problems.push(`${at} tenantId must be lowercase alphanumeric/hyphen: ${JSON.stringify(id)}`);
    } else if (byTenantId.has(id)) {
      problems.push(`duplicate tenantId "${id}"`);
    }

    if (typeof c.displayName !== 'string' || !c.displayName.trim()) {
      problems.push(`[${label}] displayName is required`);
    }

    if (!STATUSES.has(c.status)) {
      problems.push(
        `[${label}] status must be one of ${[...STATUSES].join(' | ')}: ${JSON.stringify(c.status)}`
      );
    }

    const url = checkUrl(c.apiBaseUrl, suffix);
    if (!url.ok) problems.push(`[${label}] ${url.reason}`);

    const codes = c.codes === undefined ? [] : c.codes;
    const domains = c.emailDomains === undefined ? [] : c.emailDomains;
    const normCodes = [];
    const normDomains = [];

    if (!Array.isArray(codes)) {
      problems.push(`[${label}] codes must be a list`);
    } else {
      for (const raw of codes) {
        if (typeof raw !== 'string') {
          problems.push(`[${label}] code must be a string: ${JSON.stringify(raw)}`);
          continue;
        }
        const key = raw.trim().toUpperCase();
        if (!CODE_RE.test(key)) {
          problems.push(`[${label}] code "${raw}" must be alphanumeric/hyphen, 1-32 chars`);
          continue;
        }
        const owner = byCode.get(key);
        if (owner) {
          problems.push(`duplicate company code "${key}" (${owner.tenantId} and ${label})`);
          continue;
        }
        normCodes.push(key);
      }
    }

    if (!Array.isArray(domains)) {
      problems.push(`[${label}] emailDomains must be a list`);
    } else {
      for (const raw of domains) {
        if (typeof raw !== 'string') {
          problems.push(`[${label}] emailDomain must be a string: ${JSON.stringify(raw)}`);
          continue;
        }
        const key = raw.trim().toLowerCase();
        if (!DOMAIN_RE.test(key)) {
          problems.push(`[${label}] emailDomain "${raw}" is not a valid domain`);
          continue;
        }
        const owner = byDomain.get(key);
        if (owner) {
          problems.push(`duplicate email domain "${key}" (${owner.tenantId} and ${label})`);
          continue;
        }
        normDomains.push(key);
      }
    }

    // A customer with neither a code nor a domain is unreachable. That is
    // always a mistake, and a silent one.
    if (normCodes.length === 0 && normDomains.length === 0) {
      problems.push(`[${label}] has no codes and no emailDomains — nothing can reach it`);
    }

    // Which Atomis apps this customer has bought. Validated against a known
    // set so a typo means a failed deploy rather than a crew being told their
    // company doesn't have the app they're standing in front of.
    if (c.apps !== undefined) {
      if (!Array.isArray(c.apps)) {
        problems.push(`[${label}] apps must be a list`);
      } else {
        for (const key of c.apps) {
          if (!KNOWN_APPS.has(key)) {
            problems.push(
              `[${label}] unknown app "${key}" — expected one of ${[...KNOWN_APPS].join(', ')}`
            );
          }
        }
      }
    }

    if (c.modules !== undefined) {
      if (!Array.isArray(c.modules) || c.modules.some((m) => typeof m !== 'string' || !m.trim())) {
        problems.push(`[${label}] modules must be a list of non-empty strings`);
      }
    }

    if (c.branding !== undefined && (typeof c.branding !== 'object' || c.branding === null)) {
      problems.push(`[${label}] branding must be a mapping`);
    } else if (c.branding && c.branding.primaryColor !== undefined) {
      if (!HEX_COLOUR_RE.test(String(c.branding.primaryColor))) {
        problems.push(
          `[${label}] branding.primaryColor must be #rrggbb: ${JSON.stringify(c.branding.primaryColor)}`
        );
      }
    }

    if (c.features !== undefined) {
      if (typeof c.features !== 'object' || c.features === null || Array.isArray(c.features)) {
        problems.push(`[${label}] features must be a mapping of flag -> boolean`);
      } else {
        for (const [flag, value] of Object.entries(c.features)) {
          if (typeof value !== 'boolean') {
            problems.push(`[${label}] feature "${flag}" must be true or false`);
          }
          // Invariant 3: flags are named after capabilities, never customers.
          if (typeof id === 'string' && id && flag.toLowerCase().includes(id.toLowerCase())) {
            problems.push(
              `[${label}] feature "${flag}" names a customer — flags must name capabilities`
            );
          }
        }
      }
    }

    // Only index entries that are structurally sound, so one bad row doesn't
    // cascade into confusing duplicate errors.
    if (typeof id === 'string' && TENANT_ID_RE.test(id) && !byTenantId.has(id) && url.ok) {
      const customer = {
        tenantId: id,
        displayName: c.displayName,
        status: c.status,
        codes: normCodes,
        emailDomains: normDomains,
        apiBaseUrl: url.origin,
        apps: Array.isArray(c.apps) ? c.apps.slice() : [],
        modules: Array.isArray(c.modules) ? c.modules.slice() : [],
        pinnedCoreVersion: c.pinnedCoreVersion,
        railwayProjectId: c.railwayProjectId,
        branding: c.branding || {},
        features: c.features || {},
      };
      byTenantId.set(id, customer);
      customers.push(customer);
      for (const key of normCodes) byCode.set(key, customer);
      for (const key of normDomains) byDomain.set(key, customer);
    }
  });

  if (problems.length) throw new ManifestError(problems);

  return { byCode, byDomain, byTenantId, customers };
}

function loadManifest({ file, allowedHostSuffix } = {}) {
  const suffix = allowedHostSuffix || process.env.ALLOWED_HOST_SUFFIX || DEFAULT_ALLOWED_HOST_SUFFIX;

  if (!suffix.startsWith('.')) {
    throw new ManifestError([
      `ALLOWED_HOST_SUFFIX must start with a dot (got "${suffix}") — without it, ` +
        `"evil${suffix}" would be accepted as one of ours`,
    ]);
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ManifestError([`cannot read ${file}: ${err.message}`]);
  }

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new ManifestError([`YAML parse error: ${err.message}`]);
  }

  const indexed = validateAndIndex(doc, suffix);

  return {
    ...indexed,
    allowedHostSuffix: suffix,
    loadedAt: new Date().toISOString(),
  };
}

module.exports = {
  loadManifest,
  KNOWN_APPS,
  checkUrl,
  ManifestError,
  DEFAULT_ALLOWED_HOST_SUFFIX,
};
