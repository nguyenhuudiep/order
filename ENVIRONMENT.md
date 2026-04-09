# Environment Configuration

The app now supports separate environment files for local development and production.

Loading order:

1. ENV_FILE (if provided)
2. .env.<NODE_ENV>.local
3. .env.<NODE_ENV>
4. .env.local
5. .env

## Recommended setup

- Local: use .env.development
- Production server: use .env.production

## Local (PowerShell)

$env:NODE_ENV="development"
npm start

## Production (PowerShell)

$env:NODE_ENV="production"
npm start

## Explicit file override (optional)

$env:ENV_FILE="D:\\DIEP-NH\\Copilot\\apps\\Order\\.env.production"
npm start

## Quick start from examples

Copy-Item .env.development.example .env.development
Copy-Item .env.production.example .env.production
