# Development probes

Manual tools, not part of any automated suite. Each expects the repo-root
`.env` to be populated and the relevant service to be running.

| Script | Purpose |
|---|---|
| `explain_search.js` | Prints the Postgres `EXPLAIN ANALYZE` plan for a boolean search. Use it to confirm the indexes from `src/migrations/002_search_performance.sql` are actually being chosen. |
| `search_db.js` | Ad-hoc query against the golden database. |
| `smoke_api.js` | Posts a sample payload to `/api/search` and prints the response. Requires the API to be running and `API_USER`/`API_PASS` to be set. |
| `check_drive_permissions.ts` | Verifies the Google Drive OAuth token can list and create files. |
| `check_gsheets.ts` | Verifies the Sheets client can create and write a spreadsheet. |

The two TypeScript probes previously sat in `backend/src/`, so they were
compiled into the production build output. Run them with:

```bash
cd backend && npx ts-node ../scripts/dev/check_gsheets.ts
```
