# VelocityCRM operations

Production: web `https://velocity-i5hx.onrender.com` (Render static site, repo `mpeek883/velocity`), API `https://velocitycrm-api.onrender.com` (Render web service, this repo), database `velocitycrm-db` (Render Postgres). Both services auto-deploy from `main`, so every push to `main` is a production deploy. Test and build before every push.

## Backups

1. Render Postgres: open the database in the Render dashboard and check the **Backups** tab. On the Hobby plan Render keeps recent daily snapshots; confirm the retention shown there and note it here.
2. Independent nightly backup: `.github/workflows/backup.yml` in this repo dumps the database every night at 07:30 UTC, encrypts it with AES-256, and keeps it as a workflow artifact for 90 days. It needs two repository secrets: `DATABASE_URL` (the External Database URL from the Render Postgres page) and `BACKUP_PASSPHRASE` (a long random passphrase, saved in your password manager). Until both are set the workflow skips itself.
3. Restore drill (do this once so the procedure is known):
   ```bash
   gpg --batch --passphrase "$BACKUP_PASSPHRASE" -d velocitycrm-YYYY-MM-DD.dump.gpg > db.dump
   pg_restore --clean --no-owner --dbname "$STAGING_DATABASE_URL" db.dump
   ```
   Restore into staging, never straight into production.

## Staging environment

The code is ready for a second environment; the services just need to exist.

1. Create a branch `staging` in both repos. Merge `main` into it when you want to test a release.
2. Render: **New > Web Service** from this repo, branch `staging`, name `velocitycrm-api-staging`. Copy the environment variables from the production API service, then change:
   - `DATABASE_URL` to a new Render Postgres (`velocitycrm-db-staging`) or the free tier.
   - `APP_URL` to the staging site URL (below), `API_URL` to the staging API URL.
   - `FROM_EMAIL` to a test mailbox so staging never emails clients. Leave `ACROBAT_SIGN_*` and `QBO_*` unset, or point them at sandbox accounts.
   - Optional: `LEAD_SCAN_INTERVAL_MIN=0` so staging does not scan the real inboxes.
3. Render: **New > Static Site** from `mpeek883/velocity`, branch `staging`, name `velocity-staging`, build command `npm run build`, publish directory `build`, and add the build-time variable `REACT_APP_API_URL=https://velocitycrm-api-staging.onrender.com`. The front end reads that variable everywhere it calls the API.
4. Google, Microsoft, QuickBooks and Acrobat Sign each need the staging callback URLs added to their app registrations before those integrations work on staging.
5. Release flow: push to `staging`, test there, then fast-forward `main`.

## Recurring automation (job queue)

Three jobs re-schedule themselves and start about 15 seconds after the API boots: `sla.check` (hourly), `digest.weekly` (Monday 08:00 server time; `DIGEST_WEEKDAY`, `DIGEST_HOUR`), `maintenance.daily` (archives events older than `EVENTS_RETENTION_DAYS`, default 365, prunes finished jobs after 30 days and read notifications after 90). All of them are visible on Platform > Automation > Job queue; admins can run any of them now from the SLA & digest tab.

## Environment variables added by the automation build

| Variable | Purpose |
|---|---|
| `ACROBAT_SIGN_INTEGRATION_KEY`, `ACROBAT_SIGN_CLIENT_ID`, `ACROBAT_SIGN_BASE_URL`, `ESIGN_COUNTERSIGNER_EMAIL` | Adobe Acrobat Sign; manual mode until set |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV` (`sandbox`/`production`), `QBO_ITEM_NAME`, `INVOICE_AUTO_SEND`, `INVOICE_DUE_DAYS`, `INVOICE_TERMS` | QuickBooks Online invoicing |
| `NDA_GATE=off` | turn the NDA gate on client links into a warning |
| `OWNERSHIP_MODE=off` | let any writing role edit any record |
| `LEAD_AUTO_CONVERT=true` | skip the Authorize Search checkpoint (not recommended) |
| `SLA_LEAD_REVIEW_DAYS`, `SLA_AUTHORIZE_DAYS`, `SLA_CLIENT_DAYS`, `SLA_OFFER_DAYS`, `SLA_INTERVIEW_DAYS`, `SLA_INTAKE_DAYS`, `SLA_INTERVAL_MIN` | service-level thresholds |
| `DIGEST_ROLES`, `DIGEST_WEEKDAY`, `DIGEST_HOUR` | weekly digest recipients and timing |
| `EVENTS_RETENTION_DAYS` | event log archival |
| `OUTREACH_AI_MODEL`, `OUTREACH_TOP` | candidate outreach drafting |
| `PLACEMENT_CHECKIN_EMAIL=true` | also email the consultant at each check-in |
| `REMATCH_MIN_SCORE` | bench re-match threshold (default 55) |
| `NOTIFY_EMAIL=false` | in-app notifications only, no email copies |
| `DEDUPE_THRESHOLD` | fuzzy duplicate score (default 0.7) |

## Known follow-ups that need Brad

- Google OAuth app is in Testing status: publish it or reconnect Gmail every 7 days.
- Set `FROM_NAME` on the API service to "Peek Talent Solutions".
- Rotate the Google client secret that was exposed in a screenshot, and any account passwords pasted into chat.
- Add the Acrobat Sign and QuickBooks keys when ready; both screens show the exact steps.
- Set the two backup secrets so the nightly backup starts.
