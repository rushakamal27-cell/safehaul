This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project Identity

This project is **SafeHaul** — an AI-driven National Road Safety Risk Prediction System for commercial transportation.

The repository folder may still be named `roadtalk-app`, but the product name is always **SafeHaul**.

SafeHaul is evolving from a Telegram Mini App MVP into a provider-neutral real-time fleet safety intelligence platform.

---

# Core Engineering Principles

* Read `project_context.md` before making architecture or implementation decisions.
* Act as a senior full-stack engineer and production-minded systems architect.
* Prefer modular, scalable, provider-neutral architecture.
* Preserve backwards compatibility whenever possible.
* Before major architectural changes, briefly explain the plan and trade-offs.
* Avoid tight coupling between providers and business logic.
* Never expose external API secrets/tokens to the frontend.
* All external integrations must go through secure server-side API routes.
* The database is the source of truth — not the UI.

---

# Architectural Philosophy

SafeHaul MUST remain provider-neutral.

Samsara is the first integration, not the platform identity.

Future providers may include:

* Motive
* Geotab
* Verizon Connect
* ELD providers
* weather providers
* insurance telematics
* FMCSA/public datasets

Provider payloads must always be normalized into SafeHaul internal schemas before business logic executes.

Preferred architecture:

```txt
Provider Webhook/API
        ↓
Verification Layer
        ↓
RawProviderEvent
        ↓
Normalization Layer
        ↓
DriverEvent
        ↓
Risk Engine
        ↓
ComplianceScore / Audit / Alerts
```

---

# Risk Engine Philosophy

The risk engine should remain:

* explainable;
* modular;
* auditable;
* provider-neutral;
* ML-ready.

Rule-based logic is acceptable initially if:

* explainability is preserved;
* factors remain transparent;
* recommendations remain actionable.

Risk explanations should always be understandable by:

* drivers;
* fleet managers;
* auditors;
* regulators.

---

# Security Rules

* Never expose:

  * SAMSARA_API_TOKEN
  * SAMSARA_WEBHOOK_SECRET
  * SUPABASE_SERVICE_ROLE_KEY

* Verify all webhook signatures.

* Use timing-safe comparisons for HMAC validation.

* Reject stale webhook timestamps.

* Maintain webhook idempotency/deduplication.

* Treat fleet telemetry as sensitive operational data.

* Prefer enabling RLS on telemetry-related tables.

* Use service-role access server-side only.

---

# Telegram Identity

Driver identity currently comes from Telegram WebApp SDK.

Current implementation uses:

```txt
initDataUnsafe.user
```

This is NOT production-secure yet.

Future production deployment must validate Telegram initData signatures server-side before trusting user identity.

---

# Development Guidelines

1. Keep provider-specific logic isolated:

```txt
lib/providers/{provider}/
```

2. Avoid business logic inside route handlers.

3. Prefer:

```txt
route → service/helper → DB
```

4. Preserve auditability and replay capability.

5. Store raw provider payloads whenever practical.

6. Add TODO comments where provider assumptions are uncertain.

7. Think about:

* retries;
* duplicate events;
* stale telemetry;
* replay attacks;
* scaling;
* observability;
* future ML requirements.

---

# Database Philosophy

* Database is the operational source of truth.
* UI should reflect persisted operational state.
* Avoid direct UI-driven operational logic.
* Preserve historical telemetry whenever practical.

---

# UI / Product Intent

Design language:

* dark cyberpunk / AR-inspired;
* operational-command-center aesthetic;
* real-time situational awareness.

The dashboard should feel:

* predictive;
* safety-critical;
* intelligent;
* operationally trustworthy.

Avoid:

* generic SaaS dashboard feel;
* excessive visual clutter;
* non-actionable metrics.

---

# Commands

```bash
npm run dev
npm run build
npm run start
npm run lint

npx prisma generate
npx prisma db push
npx prisma studio
```

Current workflow uses:

```txt
prisma db push
```

Migration-based workflow should be adopted before production-scale rollout.
