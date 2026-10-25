## Apache Iceberg tables in your workspace

Apache Iceberg™ is an open table format for large analytic tables: SQL tables with ACID commits, schema evolution,
time travel and hidden partitioning, shared safely by many engines at once. Learn more at <https://iceberg.apache.org>.

This app gives every workspace its own Iceberg catalog (the standard Iceberg REST catalog, backed by PostgreSQL™),
with tables stored in your workspace's storage buckets and governed by Tangram's access control.

## Getting started

1. **Create a database.** Open the app and choose **New database**. A database (Iceberg namespace) keeps its data in a
   storage bucket of the workspace; create one first under *Storage* if needed.
2. **Create tables** from the app, or with SQL from any engine below, e.g.
   `CREATE TABLE iceberg.sales.orders (id BIGINT, amount DECIMAL(12,2), ts TIMESTAMP)`.
3. **Query them** from SQL notebooks, dashboards, agents and flows — `iceberg` is the workspace's Iceberg catalog name.

## Engines

The same tables are available to every SQL engine of the workspace, with no copies:

| Engine | Read | Write (INSERT, UPDATE, DELETE, MERGE, DDL) | Table maintenance |
|---|---|---|---|
| Sail | ✓ | ✓ | ✓ |
| Spark | ✓ | ✓ | ✓ |
| StarRocks | ✓ | ✓ | ✓ |
| DuckDB / Duckling | ✓ | | |
| ClickHouse | ✓ | | |
| Snowflake | ✓ | | |

Engines reach storage with short-lived credentials scoped to the tables being used, never with workspace-wide keys.

## The table page

Each table has its own page:

- **Overview**: records, size, last commit, schema at a glance, layout (partitions, sort order), lineage and a README.
- **Schema**, **Evolution**: fields with their documentation, and every schema version with what changed.
- **Snapshots**: the commit history, with what each commit added or removed.
- **Maintenance**: health and scheduled upkeep (below).
- **Lineage**, **Access & audit**: where the data comes from and goes, who can use it, and every access.

## Table maintenance

Iceberg tables accumulate small files, old snapshots and unreferenced files as they are written. The **Maintenance** tab
keeps them in shape:

- **Health at a glance**: data files, average file size, small files, delete files, snapshot count and the oldest
  snapshot, with a hint when compaction or snapshot expiry is due.
- **A maintenance policy**: pick a Sail, Spark or StarRocks engine and turn on the jobs you want, each on its own
  schedule (hourly, daily, weekly or a custom cron):

  | Job | What it does |
  |---|---|
  | Compact data files | Rewrites small files into larger ones (target file size, minimum input files, optional filter). |
  | Expire snapshots | Drops snapshots older than N days, keeping at least the last K, and the files only they used. |
  | Remove orphan files | Deletes files no snapshot references, older than N days; a dry run only lists them. |
  | Rewrite manifests | Merges small manifests so queries plan faster. |

- **Run now**, **Pause / Resume**, and **Recent runs** with each run's result (files rewritten, snapshots removed, orphan
  files found). The tab shows a warning when a table has no policy, and an error when a job's last run failed.

**Safety.** Orphan cleanup never deletes files newer than its age limit (at least one day), starts as a dry run, and a
cleanup that deletes is never retried automatically.

**Engine notes.** Maintenance needs the latest Sail, Spark and StarRocks apps. On StarRocks, compaction ignores the
minimum input files and its filter accepts partition columns only.

**From SQL.** The same operations run on the engine directly, limited to these four procedures:

```sql
-- Sail / Spark
CALL iceberg.system.rewrite_data_files(table => 'sales.orders', options => map('min-input-files', '5'));
CALL iceberg.system.expire_snapshots(table => 'sales.orders', retain_last => 10);
CALL iceberg.system.remove_orphan_files(table => 'sales.orders', dry_run => true);
CALL iceberg.system.rewrite_manifests(table => 'sales.orders');

-- StarRocks
ALTER TABLE iceberg.sales.orders EXECUTE rewrite_data_files(rewrite_all = true);
ALTER TABLE iceberg.sales.orders EXECUTE expire_snapshots(older_than = now() - interval 7 day, retain_last = 10);
ALTER TABLE iceberg.sales.orders EXECUTE remove_orphan_files(older_than = now() - interval 3 day, dry_run = true);
ALTER TABLE iceberg.sales.orders EXECUTE rewrite_manifests();
```

## Access

Access is granted per catalog, database, table or view with preset roles:

| Resource | Roles |
|---|---|
| Database | owner, maintainer, viewer |
| Table | owner, maintainer, writer, reader, schema_admin |
| View | owner, editor, viewer |

Reading a table needs *reader*; writing needs *writer*; changing schema or running maintenance needs *maintainer*,
*schema_admin* or *owner* (the **Update metadata** permission). Engines read and write as their own service account,
which needs the owner roles on the databases they work on; workspace blueprints grant them.

### Trademarks

Apache Iceberg™ is a registered trademark or trademark of the Apache Software Foundation in the United States and/or
other countries. PostgreSQL™ is a registered trademark of the PostgreSQL Community Association of Canada.
