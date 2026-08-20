#!/usr/bin/env node
'use strict';

/**
 * CI gate for customers.yml.
 *
 * Run this on every pull request. A malformed manifest should fail the build,
 * not the deploy — this is the file where a typo routes one company's crews at
 * another company's database.
 */

const path = require('path');
const { loadManifest } = require('../lib/manifest');

const file = process.argv[2] || path.join(__dirname, '..', 'customers.yml');

try {
  const m = loadManifest({ file });
  console.log(`OK  ${path.basename(file)}`);
  console.log(
    `    ${m.byTenantId.size} customers · ${m.byCode.size} codes · ` +
      `${m.byDomain.size} email domains · suffix ${m.allowedHostSuffix}`
  );
  for (const c of m.customers) {
    const reach = [...c.codes, ...c.emailDomains].join(', ');
    const flag = c.status === 'active' ? ' ' : '!';
    console.log(`  ${flag} ${c.tenantId.padEnd(12)} ${c.apiBaseUrl.padEnd(36)} ${reach}`);
  }
  if (!m.byTenantId.has('demo')) {
    console.error('\nFAIL  the "demo" tenant is missing — App Review depends on it');
    process.exit(1);
  }
} catch (err) {
  console.error(`FAIL  ${err.message}`);
  process.exit(1);
}
