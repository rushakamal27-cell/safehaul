\# SafeHaul Project Context



\## Overview

SafeHaul — AI-driven National Road Safety Risk Prediction System



\---



\## Tech Stack

\- Next.js 14 (App Router)

\- TypeScript + Tailwind CSS

\- Next.js API Routes

\- PostgreSQL (Supabase)

\- Prisma ORM

\- Telegram WebApp SDK

\- Vercel deployment



\---



\## Current State

\- UI completed (Dashboard, Inspect, Audit, DrivingOverlay)

\- Database connected (6 tables)

\- Prisma working

\- API `/api/driver` working

\- Using mock data (no Samsara yet)



\---



\## Goal (Current)

Build:
1. Samsara mock data layer
2. Real-time Risk Engine (rule-based → future XGBoost model)
3. Explainable risk factors (why risk changes)
4. Recommendation system for drivers
5. API endpoints for risk and location


\---



\## Key Rule

\- Backend handles all external APIs

\- No tokens in frontend

\- Only processed data stored



\---



\## What Claude Should Do

\- Act as a senior full-stack engineer

\- Modify and create files when needed

\- Keep code clean and production-ready

