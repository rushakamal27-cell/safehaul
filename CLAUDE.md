# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

This project is **SafeHaul** — an AI-driven National Road Safety Risk Prediction System for commercial transportation. The codebase folder is named `roadtalk-app`, but the product name is always SafeHaul.

## Working Instructions

- Read `project_context.md` before making architecture or coding decisions.
- Act as a senior full-stack engineer and product-minded technical architect.
- Keep code production-ready, modular, and scalable.
- Before major changes, briefly explain the plan.
- Do not rename existing files unless necessary.
- All external API calls (Samsara, etc.) must go through Next.js API routes — never expose tokens to the frontend.

## Dashboard Design Intent

- The main dashboard focuses on **Real-Time Predictive Risk**, not static compliance scoring.
- The risk system is **rule-based first**, designed to be upgraded to XGBoost later.
- Risk changes must be **explainable** — show contributing factors with weights (e.g., fatigue 40%, rain 30%, speeding 30%).
- The dashboard must provide **actionable driver recommendations** based on current risk state.

## Commands

```bash
npm run dev       # Start development server
npm run build     # Build for production
npm run start     # Start production server
npm run lint      # Run ESLint
npx prisma generate          # Regenerate Prisma client after schema changes
npx prisma db push           # Push schema changes to database
npx prisma studio            # Open Prisma Studio GUI
```

No test framework is configured.

## Architecture

SafeHaul is a Telegram WebApp-based truck driver safety platform built with Next.js 14 App Router.

### Application Flow

The app is a single-page client component (`app/page.tsx`) with tab-based navigation between three screens: Dashboard, Inspect, and Audit. A full-screen "Driving Overlay" replaces the normal UI during active driving mode. The root layout (`app/layout.tsx`) injects the Telegram WebApp SDK via a script tag.

### Key Architectural Decisions

- **Telegram WebApp**: The app runs inside Telegram as a mini-app. The Telegram SDK is loaded globally in the root layout. Driver identity is derived from the Telegram user ID.
- **Mock data**: Samsara integration is not yet implemented. Screens currently use hardcoded mock data.
- **Prisma client**: Singleton pattern in `lib/prisma.ts` to avoid multiple instances in Next.js dev mode. The generated client lives at `lib/generated/prisma/` (gitignored).

### Database (PostgreSQL via Supabase)

Six Prisma models: `Company` → `Driver` → `Trip` → `SafetyEvent` / `Incident`, plus `ComplianceScore` (daily per-driver safety score with a `breakdownJson` field). The only working API endpoint is `app/api/driver/route.ts` (GET/POST by `telegramUserId`).

### Styling

Dark cyberpunk/AR aesthetic using Tailwind CSS with a custom color palette (deep dark backgrounds, cyan `#00c8ff`, green `#00e87a`) and custom fonts (Exo 2, Share Tech Mono, Rajdhani). Custom keyframe animations in `globals.css` drive AR scan-line and reticle effects.

### Planned Features (not yet built)

- Samsara mock data layer and real-time risk engine (rule-based, then XGBoost)
- Explainable risk factors and driver recommendations
- Additional API endpoints for risk scoring and location data
