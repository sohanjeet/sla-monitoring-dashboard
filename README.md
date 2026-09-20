# SLA Monitoring Dashboard

The CSV ingestion function and the PostgreSQL-backed dashboard query layer are implemented.

## Planned architecture

The React/Vite frontend will upload monitoring data to a stateless TypeScript serverless function. The function parses, validates, normalizes, exact-deduplicates, and persists reports in PostgreSQL transactionally. The frontend will later query persisted records and render a single-screen dashboard.

- `frontend/`: React + Vite + TypeScript client
- `function/`: TypeScript serverless-function boundary and processing placeholders
- `database/`: PostgreSQL schema placeholder
- `sample-data/`: reserved for non-source fixtures; supplied assignment files remain outside this scaffold and unchanged

## Local setup

1. Copy `.env.example` to `.env` and set local values.
2. Install dependencies in both `frontend/` and `function/`.
3. Run `npm run dev` from `frontend/` for the client.
4. Run `npm run build` in either package to verify compilation.

## CSV import endpoint

`POST /imports` is implemented as an AWS Lambda/API Gateway HTTP API v2 function, with deployment configuration in `serverless.yml`. It accepts either:

- `multipart/form-data` with exactly one `file` field containing a `.csv` file; or
- a raw UTF-8 CSV body with `Content-Type: text/csv` or `application/csv` (optional `X-File-Name`).

Uploads are limited to 4 MiB by default (`MAX_UPLOAD_BYTES`, capped at 25 MiB), and invalid uploads return structured JSON errors. The function processes each request in memory, uses the existing parser/cleaner module, and stores the dataset, normalized reports, and rejected rows in one PostgreSQL transaction. Any persistence failure rolls back the entire upload.

A successful request returns HTTP 201 with a JSON summary such as:

```json
{
  "totalRows": 120,
  "insertedRows": 115,
  "duplicates": 2,
  "rejectedRows": 5,
  "issues": { "invalid_timestamp": 3, "duplicate_exact": 2 }
}
```

Set `DATABASE_URL` before deployment. Set `DATABASE_SSL=require` for managed PostgreSQL instances that require TLS. No credentials are committed to this repository.

## Dashboard query endpoints

`GET /api/logs` returns normalized report records in deterministic chronological
order. It accepts either `date=YYYY-MM-DD` or both `from=YYYY-MM-DD` and
`to=YYYY-MM-DD`, plus optional `service=svc-auth` and pagination parameters
`page` (default `1`) and `limit` (default `50`, maximum `100`). Dates are
UTC calendar days and range endpoints are inclusive.

`GET /api/stats` accepts the same date and service filters and returns overall
and per-service counts, availability, average latency, p95 latency, and the
SLA outcome.

Statistics follow the documented data findings: records are collapsed by
`dataset_id`, service, and timestamp before availability is calculated; only
unanimous 2xx slots are successful and unanimous 5xx slots are failed. Mixed
health slots and unmapped statuses are excluded from SLA counts. Latency uses a
slot only when its reports have exactly one non-null normalized latency value.
The SLA target is 99.9% availability; values at or above it are `met`.

## Scope notes

CSV findings, cleaning rules, dashboard statistics, live URLs, and deployment instructions will be documented after the corresponding implementation work. Authentication, Redux, Docker, CI, and multi-tenancy are intentionally out of scope.
