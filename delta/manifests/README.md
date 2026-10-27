## Delta Lake catalog

Delta Lake is an open table format with ACID transactions, time travel and schema evolution on
object storage. This app runs a Delta Lake catalog for the workspace. It speaks the Unity Catalog
REST API (`/api/2.1/unity-catalog`), so Sail, Spark and DuckDB can read and write the same tables.
StarRocks reads them (read-only) through the StarRocks app's Delta engine catalogs; grant the
StarRocks cluster's service account the Database `viewer` and Table `reader` roles on the databases it may read.

- One catalog per workspace, named `delta`. Databases (schemas) and tables live in Tangram storage
  folders; access follows the Database and Table roles.
- Engines never get bucket keys: each table read or write gets short-lived credentials scoped to
  that table's folder and to what the caller may do (read-only or read-write).
- Commits go straight to the Delta log in storage, so any Delta reader can also read a table by path.

## Versions

| Component | Version |
|---|---|
| Catalog server (Delta log reads and commits) | Delta Kernel 4.3.1 (Java) |
| Catalog API | Unity Catalog REST API 2.1 (subset) |
| Sail | Sail 0.7.2 (Tangram build): read, write, DDL |
| Spark | Delta Lake 4.3.1 (`delta-spark`): read, write, DDL |
| DuckDB / Duckling | DuckDB 2.0.0 with its `delta` extension: read, INSERT |
| StarRocks | StarRocks 4.1.6 (Tangram build): read-only |

## Create a database

Create a storage bucket in the workspace first, then a database from a SQL engine, e.g. on Sail:

```sql
CREATE DATABASE delta.sales;
CREATE TABLE delta.sales.orders (id BIGINT, amount DOUBLE) USING delta;
```

Names must be lower-case letters, digits and underscores.

## Table maintenance

Delta tables accumulate small files, unreferenced files and soft-deleted rows as they are written. The **Maintenance**
tab keeps them in shape:

- **Health at a glance**: data files (and how many are under 32 MiB), average file size, total size, deletion vectors
  and deleted rows, the layout (partitioned, clustered or unpartitioned) and the current version, with a hint when
  compaction or a purge is due.
- **A maintenance policy**: pick a Sail or Spark engine and turn on the jobs you want, each on its own schedule
  (hourly, daily, weekly or a custom cron):

  | Job | What it does |
  |---|---|
  | Optimize | Bin-packs small files into larger ones (`OPTIMIZE`), optionally only `WHERE` a partition-column filter, or Z-ordered by up to 32 columns (not for liquid-clustered tables). |
  | Vacuum | Deletes files no table version in the retention window references (`VACUUM ... RETAIN n HOURS`, 168 hours to 10 years). |
  | Purge soft-deleted rows | Rewrites files with deletion vectors so deleted rows are gone for good (`REORG TABLE ... APPLY (PURGE)`). |

- **Run now**, **Pause / Resume**, and **Recent runs** with each run's result (files added and removed). The tab shows
  a warning when a table has no policy, and an error when a job's last run failed.

Only table owners change the policy; everyone else who can read the table sees it read-only.

**Safety.** Vacuum never deletes files a version inside its retention window still uses (at least 7 days), so a rerun
is always safe; failed runs retry automatically.

**From SQL.** The same commands run on Sail and Spark directly:

```sql
OPTIMIZE delta.sales.orders;
OPTIMIZE delta.sales.orders WHERE order_date >= '2026-01-01' ZORDER BY (customer_id);
VACUUM delta.sales.orders RETAIN 168 HOURS;
REORG TABLE delta.sales.orders APPLY (PURGE);
```

StarRocks and DuckDB don't run Delta maintenance.

### Trademarks

- Delta Lake is a trademark of LF Projects, LLC. Unity Catalog is a trademark of LF Projects, LLC.
- PostgreSQL™ is a registered trademark of the PostgreSQL Community Association of Canada.
