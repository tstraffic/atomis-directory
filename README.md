# Atomis Directory Service

The one URL compiled into the Atomis app. It answers **where** a company's
deployment lives — never **who** the user is.

```
app (one binary, knows only this service)
        │  GET /resolve?code=TS   or   ?email=someone@tstc.com.au
        ▼
   directory  ── reads customers.yml, no database, no customer data
        │  { tenantId, apiBaseUrl, modules, branding, features }
        ▼
app validates the host against a compiled-in allowlist, caches it, and from
then on talks only to  https://ts.atomis.com.au  — the directory is out of
the picture entirely.
```

Credentials go to the tenant's own deployment. The directory never sees them.

Adding a customer is a pull request against `customers.yml` plus a deployment.
It never requires an app release — the build already in the store can reach
anyone listed here.

## Run it

```bash
npm ci
npm test          # 25 tests, no network needed
npm run validate  # what CI runs against customers.yml
npm start
```

```bash
curl "http://localhost:3000/resolve?code=DEMO"
```

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /resolve?code=…` | none | Resolve by company code. Publicly cacheable for an hour. |
| `GET /resolve?email=…` | none | Resolve by the domain part of an email. `Cache-Control: private, no-store`. |
| `POST /resolve` | none | Same, with the email in the body instead of the URL. |
| `POST /heartbeat` | `x-fleet-key` | A tenant deployment reporting its version and health. |
| `GET /fleet` | `x-fleet-key` | What every customer is running. |
| `GET /health` | none | Platform healthcheck. |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `FLEET_KEY` | *(unset)* | Shared secret for `/fleet` and `/heartbeat`. Unset ⇒ both fail closed with 503. |
| `ALLOWED_HOST_SUFFIX` | `.atomis.com.au` | **The leading dot is load-bearing.** Without it, `evil-atomis.com.au` would be accepted as one of ours. |
| `RATE_LIMIT_MAX` | `60` | `/resolve` requests per IP per minute. |
| `MANIFEST_PATH` | `./customers.yml` | |

## Things in here that look like preferences and are not

**Unknown and suspended return an identical 404.** `/resolve` runs before
login, so it cannot be authenticated, which makes it an enumeration surface.
Same status, same body, same headers for "no such company" and "company
suspended" — there is a test asserting the responses are byte-identical. Don't
add a friendlier message for one case.

**Every manifest problem is a hard failure at boot.** An `apiBaseUrl` outside
the allowlisted suffix, a duplicate code, a duplicate email domain, a customer
with no way to reach it — the process exits rather than starting up and
misrouting someone. Run `npm run validate` in CI so this fails the pull request
instead of the deploy.

**Email addresses are never logged in full.** Only the domain, which is the
part that routes. Responses resolved by email are `no-store`, because the
request URL contains personal information and must not sit in a shared cache.

**`/resolve` returns only what the app needs.** Never the Railway project id,
the pinned version, the display name, or anything about any other customer.

**The rate limit is deliberately loose.** A whole depot behind one NAT shares an
IP; locking a crew out at 5am is worse than a slow enumeration of company codes,
which aren't secrets anyway.

**Heartbeats live in memory.** They're empty after a restart, which is why
`/fleet` also reports `directoryStartedAt` — so "no heartbeat" can be told apart
from "the directory redeployed a minute ago". If you want durable history, that
belongs in a monitoring system, not in here. This service stays boring.

## Adding a customer

1. Add an entry to `customers.yml`. Codes are uppercase and memorable — a crew
   member types this on a phone at 5am. Never reuse a retired code.
2. `npm run validate` locally, then open a pull request. Keep this file under
   review protection: a typo here routes one company's crews at another
   company's database.
3. Deploy the tenant, attach `https://<tenantId>.atomis.com.au`, and redeploy
   this service so it picks up the new manifest.

No app release, at any point.

## Deploying

Its own project, sharing nothing with any tenant. Every first-time login in the
fleet depends on this being up, so it gets no database, no shared
infrastructure, and as few moving parts as possible.

- Healthcheck: `/health`
- Set `FLEET_KEY` to a generated secret and give the same value to every tenant
  deployment.
- Attach `directory.atomis.com.au`. **This hostname is compiled into the app and
  can never change.**
