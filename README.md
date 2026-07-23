# Aly & Shin Product Lab

Internal Product Lab for Aly & Shin.

This is the modern rebuild target for product proof, costing, tasting feedback, content journaling, and launch readiness. It is intentionally separate from the old PHP/MySQL prototype.

## Current Status

The first version is a local Next.js Product Lab with:

- Seeded Aly & Shin product data
- Product readiness dashboard
- Product proof batch form
- Costing summary form
- Tasting feedback form
- Content journal form
- Local browser persistence
- Supabase-ready schema files

Local browser persistence means entries are saved in the current browser for testing. To share data between Aly and Shin online, connect Supabase next.

## Stack

- Next.js
- TypeScript
- Tailwind CSS
- Supabase
- Vercel

## Local Setup

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Supabase Setup

1. Create a Supabase project.
2. Copy `.env.example` to `.env.local`.
3. Add:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

4. Run `supabase-schema.sql` in the Supabase SQL editor.

5. Create app users:

- Go to Authentication > Users.
- Add the husband/admin email.
- Add the wife/admin email.
- Set temporary passwords.

6. Sign in at the app with one of those users.

## Persistence Mode

If `.env.local` has Supabase keys, the app uses Supabase and requires login.

If Supabase keys are missing, the app falls back to local browser storage for workflow testing.

## MVP Scope

Build first:

- Private login
- Product list
- Product proof batches
- Costing
- Tasting feedback
- Content journal
- Launch readiness dashboard

Do not build public ordering yet.
# Aly & Shin Product Lab

## Internal CLI

Use the lab CLI to verify app workflows without clicking through the UI every time:

```bash
npm run lab -- help
npm run lab -- validate-schema
npm run lab -- audit-costing
npm run lab -- test-proof-to-costing
npm run lab -- context
```

After linking it globally with `npm link`, the same CLI is available as:

```bash
product-lab help
product-lab validate-schema
product-lab audit-costing
product-lab test-proof-to-costing
product-lab context
```

The CLI is intentionally small. It should grow when a workflow needs repeatable verification, especially costing, proof batch formula transfer, Supabase schema checks, and launch readiness audits.
