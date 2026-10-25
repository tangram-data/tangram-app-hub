## Open Table Format
Apache Iceberg™ is a high-performance format for huge analytic tables. Iceberg brings the reliability and simplicity of SQL tables to big data, while making it possible for engines like Spark, Trino, Flink, Presto, Hive and Impala to safely work with the same tables, at the same time.

Background and documentation is available at <https://iceberg.apache.org>

This application allows to deploy an Iceberg REST catalog service backed by Iceberg JDBC catalog using
PostgreSQL™ as database. 

## Create an Iceberg Table

Before you can create an Iceberg table, you need to create an Iceberg database(or namespace) first. 
To create an Iceberg database, you need to create a storage bucket in the workspace, to create a storage bucket, you can
navigate to `workspace>your workspace> storage > storage bucket` in Tangram OS UI. Then you can create an Iceberg database
using the created bucket as data storage. 


## Table maintenance

Iceberg tables accumulate small files, old snapshots and unreferenced files as they are written. Each table page has a
**Maintenance** tab that keeps them in shape on a schedule.

- **Health at a glance**: data files, average file size, small files, delete files, snapshot count and the oldest
  snapshot, with a hint when compaction or snapshot expiry is due.
- **Maintenance policy**: pick a Sail, Spark or StarRocks engine of the workspace and turn on the jobs you want, each
  with its own schedule (hourly, daily, weekly or a custom cron):

  | Job | What it does |
  |---|---|
  | Compact data files | Rewrites small files into larger ones (target file size, minimum input files, optional filter). |
  | Expire snapshots | Drops snapshots older than N days, keeping at least the last K, and the files only they used. |
  | Remove orphan files | Deletes files no snapshot references, older than N days; a dry run only lists them. |
  | Rewrite manifests | Merges small manifests so queries plan faster. |

- **Run now**, **Pause / Resume**, and a **Recent runs** list with each run's result (files rewritten, snapshots removed,
  orphan files found). The tab shows a warning when a table has no policy and an error when a job's last run failed.

Safety: orphan cleanup never deletes files newer than its age limit (at least one day), defaults to a dry run, and a
cleanup that deletes is never retried automatically.

Permissions: changing a policy requires the **Update metadata** permission on the table. The engine works on the table as
its own service account, which needs the owner roles on the table's database; workspace blueprints grant them.

Engines:

- **Sail** and **Spark** run all four jobs. They need the latest Sail and Spark apps.
- **StarRocks** runs all four jobs with the latest StarRocks app. Its compaction ignores the minimum input files, and
  its filter accepts partition columns only.

The same maintenance can be run from SQL on the engine, limited to these four procedures:

```sql
-- Sail / Spark
CALL iceberg.system.rewrite_data_files(table => 'sales.orders', options => map('min-input-files', '5'));
CALL iceberg.system.expire_snapshots(table => 'sales.orders', retain_last => 10);
CALL iceberg.system.remove_orphan_files(table => 'sales.orders', dry_run => true);
CALL iceberg.system.rewrite_manifests(table => 'sales.orders');

-- StarRocks
ALTER TABLE iceberg.sales.orders EXECUTE rewrite_data_files(rewrite_all = true);
ALTER TABLE iceberg.sales.orders EXECUTE expire_snapshots(older_than = now() - interval 7 day, retain_last = 10);
```

`iceberg` is the workspace's Iceberg catalog name.

### Trademarks

- Apache Iceberg™ is registered trademarks or trademarks of the Apache Software Foundation in the United States and/or other countries.

-  PostgreSQL™ are all registered trademarks of the PostgreSQL Community Association of Canada.



