# CloudPunch backend — SQL migrations

Ordered, forward-only SQL migrations applied to Aurora PostgreSQL.

## Filename convention

`NNNN_short_slug.sql`, monotonic 4-digit prefix. New migrations
increment the number; existing files are never renamed or edited
after merge (a follow-up migration corrects mistakes).

## Runner

Phase 1 lands the SQL files. The migration runner (`node-pg-migrate`
or a small custom applier) lands in Phase 2 when the backend actually
connects to a database. Until then, migrations are reviewed but not
executed.

## Rules

- **Forward-only.** No reversible/`DOWN` blocks. If a migration is
  wrong, write a new migration that fixes it.
- **Idempotent where possible.** Use `IF NOT EXISTS` on extensions
  and helper types.
- **Include a header comment** describing the migration's purpose and
  the ADRs it implements.
- **No `UPDATE`/`DELETE` on append-only tables** (`time_event`,
  `audit_log`) inside any migration. CI (Phase 2) will parse for this.
- **Never store secrets** in migrations. Configuration comes from
  Parameter Store; secrets from Secrets Manager.

## Applied order

| #    | Slug              | Purpose                                                                           | Introduced in |
| ---- | ----------------- | --------------------------------------------------------------------------------- | ------------- |
| 0001 | baseline_identity | users, employees (with source column), devices, departments, audit_log foundation | Phase 1c      |
