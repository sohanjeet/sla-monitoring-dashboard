# SLA Monitoring Dashboard

Live dashboard: https://sla-monitoring-dashboard-tau.vercel.app
Live API: https://b45bh83jw4.execute-api.ap-south-1.amazonaws.com

Last verified live: 2026-09-20.

## Architecture

The React/Vite single-page dashboard is hosted on Vercel. It sends CSV uploads and dashboard queries directly to an AWS API Gateway HTTP API. API Gateway invokes stateless TypeScript AWS Lambda functions, which validate and normalize the data before writing it transactionally to Neon PostgreSQL. The dashboard reads the persisted data via the same API.

`Vercel frontend -> API Gateway -> Lambda -> Neon PostgreSQL`

The browser is deliberately limited to `VITE_API_BASE_URL`; `DATABASE_URL` is Lambda-only. API Gateway allows the production Vercel origin, `GET`, `POST`, and `OPTIONS`.

## Local setup

1. Install dependencies in the repository root, `function/`, and `frontend/` with `npm install`.
2. Copy `function/.env.example` to `function/.env`. Set `DATABASE_URL`, retain `DATABASE_SSL=require`, and set `ALLOWED_ORIGIN` to the local frontend origin.
3. Copy `frontend/.env.example` to `frontend/.env` and set `VITE_API_BASE_URL` to the API being used for development.
4. Run `npm run test`, `npm run check`, and `npm run build` from the repository root. Run `npm run dev --prefix frontend` to serve the client.

Real `.env` files are ignored; never commit database or cloud credentials.

## Deployment

Build the Lambda with `npm run build:function`. Deploy `serverless.yml` with the production `DATABASE_URL`, `DATABASE_SSL=require`, and `ALLOWED_ORIGIN=https://sla-monitoring-dashboard-tau.vercel.app`. Build the Vite app with `npm run build:frontend` and deploy it to Vercel with `VITE_API_BASE_URL=https://b45bh83jw4.execute-api.ap-south-1.amazonaws.com`.

The API exposes `POST /imports`, `GET /api/logs`, and `GET /api/stats`. Uploads accept one CSV `file` multipart field or a raw UTF-8 CSV body. Queries support a UTC `date`, or an inclusive UTC `from`/`to` range, a service filter, and pagination. Errors use JSON responses and appropriate 4xx/5xx statuses.

## Data findings and assumptions

The supplied logs use three valid timestamp representations (RFC 3339 UTC, RFC 3339 with an offset, and ten-digit Unix seconds) and are not in chronological row order. Timestamps are normalized to UTC and stored as `observed_at`; raw timestamp evidence is retained. The source datasets overlap, so every upload receives a distinct `dataset_id` rather than being deduplicated across uploads.

Other quality rules are:

- Exact duplicate reports are rejected with an audit record; malformed rows and the invalid `999` status are also retained in `import_rejections`.
- Blank and negative latencies retain valid status evidence but become `NULL` for latency aggregates. Seconds are normalized to milliseconds.
- Availability is calculated once per dataset/service/UTC slot: unanimous 2xx is healthy, unanimous 5xx is unavailable, and mixed or unmapped status slots are excluded. A slot contributes latency only when it has exactly one valid normalized latency value.
- Statistics show overall and per-service availability, counts, average latency, p95 latency, and the 99.9% SLA status because these directly support on-call and billing review.

## Improvements with more time

- Add an immutable import-history/audit view and surface rejected/conflicted-slot counts in the dashboard.
- Add automated browser integration tests and deployment smoke checks.
- Add alerts or incident timelines after agreeing alert thresholds and retention policy with stakeholders.

Authentication, multi-tenancy, Docker, and CI are intentionally out of scope for this assignment.
