# Deploy gaps progress

Branch: deploy-gaps
Base: dec5f265f1a192a19798f4b2bb1a83be995907e7
Ledger for the four deploy-gap items. Tasks marked complete are done.


Task 1: complete (commits dec5f26..4e0d6e1, review clean). Minor: blank CONFIG_DIR is treated as unset but untested.

Task 2: complete (commits 4e0d6e1..0723652, review clean). Minors for final review: rollback/client.end can mask the original error; CLI stdout is not asserted to be only "migrations applied"; ALTER ROLE password can appear in Postgres logs if log_statement or a failed statement is logged; baselineSentinelsPresent has no direct unit call. ⚠️ Railway array preDeployCommand: confirmed against Railway config-as-code docs example preDeployCommand = ["npm run db:migrate"].

Task 3: complete (commits 0723652..8e543c9, review clean). Plan answer: Tasks 7, 8, 15, and 16 were not scoped to a live Postgres web app; they produced PGlite/jsdom libraries and components. Missing were pg, login lookup, sign-up/sign-in, a real /, and session-wired onboarding and Run now. Minors for final review: pg.ts does not throw when DATABASE_URL is missing (Pool may use PG* and connect as owner); blank email is only blocked in signUp not in SQL; email is not trimmed; Ubah varian creates a new project; action errors have no Indonesian UI; Secure cookie ignores the request protocol; no sign-in rate limit; svg deletions sit in the blank-email commit. ⚠️ Dockerfile: deploy/web.Dockerfile COPY apps/web includes 005 and pre-deploy runs migrate. ⚠️ redirects inside Suspense match the cache-components docs the brief required.

Task 4: complete (commits 8e543c9..814c158, review clean). Minor: default interval 180 is the literal in code; the idle test would also pass for any interval above 160.

Task 4: complete (commits 8e543c9..814c158, review clean). Minor: default interval test originally stopped at t=160.

Final review (dec5f26..814c158): With fixes. Important: revoke schema_migrations; nullif on users_email_lookup; fail closed without DATABASE_URL and refuse privileged roles.
Fix commits a25f3db..0415c58. Re-review Approved. No remaining Important issues.
Direct createProjectAction can still insert another project; judged Minor because the plan allows multiple projects per customer.

Final suites after fixes: web typecheck pass, lint pass, vitest 109 passed, worker pytest 56 passed 0 skipped with POSTGRES_TEST_URL, eval 5 passed, next build pass. Docker COPY sanity pass. Browser on next dev: / -> /masuk, daftar -> onboarding, create brand, save variant, Run now queued a due manual job. app_user select without a tenant GUC saw no rows.
