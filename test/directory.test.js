'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadManifest, ManifestError } = require('../lib/manifest');
const { createApp } = require('../server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atomis-directory-'));
let seq = 0;

function manifestFile(yaml) {
  const file = path.join(TMP, `customers-${seq++}.yml`);
  fs.writeFileSync(file, yaml, 'utf8');
  return file;
}

function load(yaml, opts) {
  return loadManifest({ file: manifestFile(yaml), ...opts });
}

/** A customer entry with sane defaults, so each test varies only what it tests. */
function entry(over = {}) {
  const c = {
    tenantId: 'acme',
    displayName: 'Acme Traffic',
    status: 'active',
    codes: ['ACME'],
    emailDomains: ['acme.com.au'],
    apiBaseUrl: 'https://acme.atomis.com.au',
    ...over,
  };
  const lines = [
    `  - tenantId: ${c.tenantId}`,
    `    displayName: ${JSON.stringify(c.displayName)}`,
    `    status: ${c.status}`,
    `    codes: [${c.codes.join(', ')}]`,
    `    emailDomains: [${c.emailDomains.join(', ')}]`,
    `    apiBaseUrl: ${c.apiBaseUrl}`,
  ];
  if (c.extra) lines.push(...c.extra);
  return lines.join('\n');
}

function doc(...entries) {
  return `customers:\n${entries.join('\n')}\n`;
}

const VALID = doc(
  entry(),
  entry({
    tenantId: 'brightline',
    displayName: 'Brightline',
    status: 'suspended',
    codes: ['BRIGHT'],
    emailDomains: ['brightline.com.au'],
    apiBaseUrl: 'https://brightline.atomis.com.au',
  }),
  entry({
    tenantId: 'demo',
    displayName: 'Atomis Demo',
    codes: ['DEMO'],
    emailDomains: [],
    apiBaseUrl: 'https://demo.atomis.com.au',
    extra: [
      '    railwayProjectId: 6f1c2b90-0000-0000-0000-0000000000ff',
      '    pinnedCoreVersion: "1.2.3"',
      '    modules: [traffic-control]',
      '    branding:',
      '      primaryColor: "#111827"',
      '    features:',
      '      swms_module: true',
    ],
  })
);

function problemsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ManifestError, `expected ManifestError, got ${err}`);
    return err.problems.join('\n');
  }
  assert.fail('expected the manifest to be rejected, but it loaded');
}

// ---------------------------------------------------------------------------
// The security boundary: which hosts a manifest may point the fleet at.
// ---------------------------------------------------------------------------

test('near-miss hosts are all rejected at load time', () => {
  const cases = {
    // The leading dot in ".atomis.com.au" is what makes this fail.
    'https://evil-atomis.com.au': /host must end with/,
    'https://atomis.com.au.evil.com': /host must end with/,
    'https://api-x.atomis.com.au.attacker.net': /host must end with/,
    'https://atomis.com.au': /host must end with/,
    'http://acme.atomis.com.au': /must be https/,
    'https://attacker@acme.atomis.com.au': /must not embed credentials/,
    'not-a-url': /not a valid URL/,
  };
  for (const [url, expected] of Object.entries(cases)) {
    const problems = problemsOf(() => load(doc(entry({ apiBaseUrl: url }))));
    assert.match(problems, expected, `for ${url}`);
  }
});

test('an allowlist suffix without a leading dot is refused outright', () => {
  const problems = problemsOf(() =>
    load(doc(entry()), { allowedHostSuffix: 'atomis.com.au' })
  );
  assert.match(problems, /must start with a dot/);
});

test('apiBaseUrl is normalised to its origin, so a stray path cannot leak', () => {
  const m = load(doc(entry({ apiBaseUrl: 'https://acme.atomis.com.au/w/home?x=1' })));
  assert.equal(m.byTenantId.get('acme').apiBaseUrl, 'https://acme.atomis.com.au');
});

// ---------------------------------------------------------------------------
// Manifest validation — every one of these is a misrouting bug caught at boot.
// ---------------------------------------------------------------------------

test('duplicate company codes are rejected', () => {
  const problems = problemsOf(() =>
    load(doc(entry(), entry({ tenantId: 'other', codes: ['acme'], emailDomains: ['other.com.au'], apiBaseUrl: 'https://other.atomis.com.au' })))
  );
  assert.match(problems, /duplicate company code "ACME"/);
});

test('duplicate email domains are rejected', () => {
  const problems = problemsOf(() =>
    load(doc(entry(), entry({ tenantId: 'other', codes: ['OTHER'], apiBaseUrl: 'https://other.atomis.com.au' })))
  );
  assert.match(problems, /duplicate email domain "acme.com.au"/);
});

test('duplicate tenant ids are rejected', () => {
  const problems = problemsOf(() =>
    load(doc(entry(), entry({ codes: ['OTHER'], emailDomains: ['other.com.au'] })))
  );
  assert.match(problems, /duplicate tenantId "acme"/);
});

test('a customer with no code and no email domain is rejected as unreachable', () => {
  const problems = problemsOf(() => load(doc(entry({ codes: [], emailDomains: [] }))));
  assert.match(problems, /nothing can reach it/);
});

test('a malformed entry is rejected rather than skipped', () => {
  assert.match(problemsOf(() => load(doc(entry({ tenantId: 'Acme_Corp' })))), /tenantId must be lowercase/);
  assert.match(problemsOf(() => load(doc(entry({ status: 'paused' })))), /status must be one of/);
  assert.match(problemsOf(() => load('customers: []\n')), /"customers" is empty/);
  assert.match(problemsOf(() => load('nope: true\n')), /must be a list/);
});

test('a feature flag naming a customer is rejected (invariant 3)', () => {
  const problems = problemsOf(() =>
    load(doc(entry({ extra: ['    features:', '      enabled_for_acme: true'] })))
  );
  assert.match(problems, /names a customer/);
});

test('every problem is reported at once, not just the first', () => {
  const problems = problemsOf(() =>
    load(doc(entry({ status: 'paused', apiBaseUrl: 'http://acme.atomis.com.au' })))
  );
  assert.match(problems, /status must be one of/);
  assert.match(problems, /must be https/);
});

// ---------------------------------------------------------------------------
// The endpoints.
// ---------------------------------------------------------------------------

const FLEET_KEY = 'test-fleet-key';

async function withServer(fn, { fleetKey = FLEET_KEY, yaml = VALID } = {}) {
  const manifest = load(yaml);
  const app = createApp({ manifest, fleetKey, rateLimitMax: 10000 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('resolves by company code, case-insensitively and ignoring whitespace', async () => {
  await withServer(async (base) => {
    for (const q of ['ACME', 'acme', '  AcMe  ']) {
      const res = await fetch(`${base}/resolve?code=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `code ${JSON.stringify(q)}`);
      const body = await res.json();
      assert.equal(body.tenantId, 'acme');
      assert.equal(body.apiBaseUrl, 'https://acme.atomis.com.au');
    }
  });
});

test('resolves by email domain, case-insensitively', async () => {
  await withServer(async (base) => {
    for (const q of ['suhail@acme.com.au', 'SUHAIL@ACME.COM.AU', 'a+tag@acme.com.au']) {
      const res = await fetch(`${base}/resolve?email=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `email ${q}`);
      assert.equal((await res.json()).tenantId, 'acme');
    }
  });
});

test('unknown and suspended return byte-identical responses (invariant 8)', async () => {
  await withServer(async (base) => {
    const unknown = await fetch(`${base}/resolve?code=NOPE`);
    const suspended = await fetch(`${base}/resolve?code=BRIGHT`);

    assert.equal(unknown.status, 404);
    assert.equal(suspended.status, 404);
    assert.equal(await unknown.text(), await suspended.text());
    // Headers must not differentiate them either.
    assert.equal(unknown.headers.get('cache-control'), suspended.headers.get('cache-control'));
    assert.equal(unknown.headers.get('content-length'), suspended.headers.get('content-length'));

    // And the same must hold for the email path.
    const unknownEmail = await fetch(`${base}/resolve?email=x@nobody.example`);
    const suspendedEmail = await fetch(`${base}/resolve?email=x@brightline.com.au`);
    assert.equal(await unknownEmail.text(), await suspendedEmail.text());
  });
});

test('missing parameters return 400, not a 404 that leaks nothing exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/resolve`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'provide code or email' });
  });
});

test('repeated query parameters do not crash the lookup', async () => {
  await withServer(async (base) => {
    // Express parses ?code=a&code=b into an array; it must not be coerced.
    const res = await fetch(`${base}/resolve?code=ACME&code=DEMO`);
    assert.equal(res.status, 404);
  });
});

test('the response never leaks fleet internals', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/resolve?code=DEMO`)).json();
    assert.deepEqual(Object.keys(body).sort(), [
      'apiBaseUrl',
      'branding',
      'features',
      'modules',
      'tenantId',
    ]);
    assert.ok(!('railwayProjectId' in body));
    assert.ok(!('pinnedCoreVersion' in body));
    assert.ok(!('displayName' in body));
  });
});

test('a response keyed on an email address is never publicly cacheable', async () => {
  await withServer(async (base) => {
    const byCode = await fetch(`${base}/resolve?code=ACME`);
    assert.match(byCode.headers.get('cache-control'), /public/);

    const byEmail = await fetch(`${base}/resolve?email=suhail@acme.com.au`);
    assert.match(byEmail.headers.get('cache-control'), /private/);
    assert.match(byEmail.headers.get('cache-control'), /no-store/);
  });
});

test('POST /resolve keeps the email out of the URL', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'suhail@acme.com.au' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).tenantId, 'acme');
    assert.match(res.headers.get('cache-control'), /no-store/);
  });
});

test('/health reports without authentication', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.customers, 3);
  });
});

test('unknown routes return the same generic 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/customers`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// Fleet registry.
// ---------------------------------------------------------------------------

test('/fleet and /heartbeat require the fleet key', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/fleet`)).status, 401);
    assert.equal((await fetch(`${base}/fleet`, { headers: { 'x-fleet-key': 'wrong' } })).status, 401);
    assert.equal(
      (
        await fetch(`${base}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId: 'acme', version: '1.0.0' }),
        })
      ).status,
      401
    );
  });
});

test('a heartbeat is recorded and shows up in /fleet', async () => {
  await withServer(async (base) => {
    const beat = await fetch(`${base}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fleet-key': FLEET_KEY },
      body: JSON.stringify({ tenantId: 'acme', version: '1.4.2', healthy: true }),
    });
    assert.equal(beat.status, 200);

    const fleet = await (await fetch(`${base}/fleet`, { headers: { 'x-fleet-key': FLEET_KEY } })).json();
    const acme = fleet.customers.find((c) => c.tenantId === 'acme');
    assert.equal(acme.lastHeartbeat.version, '1.4.2');
    assert.equal(acme.lastHeartbeat.healthy, true);

    // Reporting our own start time is what distinguishes "tenant is down" from
    // "the directory restarted and lost its in-memory heartbeats".
    assert.ok(fleet.directoryStartedAt);
    const demo = fleet.customers.find((c) => c.tenantId === 'demo');
    assert.equal(demo.lastHeartbeat, null);
  });
});

test('a heartbeat for an unlisted tenant is rejected', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fleet-key': FLEET_KEY },
      body: JSON.stringify({ tenantId: 'not-a-customer', version: '1.0.0' }),
    });
    assert.equal(res.status, 404);
  });
});

test('with no FLEET_KEY configured, the fleet endpoints fail closed', async () => {
  await withServer(
    async (base) => {
      assert.equal((await fetch(`${base}/fleet`, { headers: { 'x-fleet-key': '' } })).status, 503);
    },
    { fleetKey: '' }
  );
});

test('the shipped customers.yml is valid', () => {
  const m = loadManifest({ file: path.join(__dirname, '..', 'customers.yml') });
  assert.ok(m.byTenantId.has('demo'), 'the demo tenant must exist for App Review');
  assert.equal(m.byTenantId.get('demo').status, 'active');
  for (const c of m.customers) {
    assert.match(c.apiBaseUrl, /^https:\/\/[a-z0-9-]+\.atomis\.com\.au$/);
  }
});
