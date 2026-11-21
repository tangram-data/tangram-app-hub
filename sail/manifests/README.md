# Sail — User Guide

The Sail app runs a [Sail](https://lakesail.com) (LakeSail) engine in your workspace: a Spark-compatible
compute engine written in Rust. It supports both **Apache Iceberg** and **Delta Lake**: it reads and
writes the tables of Tangram SQL catalogs in either format. The app
deploys one Flight SQL driver that starts workers on demand and removes them when idle, and
registers the cluster as a SQL engine so it is queryable through the Tangram SQL proxy with any
PostgreSQL client, from SQL notebooks, dashboards and flows.

A workspace can run **several clusters**, each with its own name and sizing, all deployed into the
app and each registered as its own SQL engine. An idle cluster costs only its driver.

---

## Cluster

### Lifecycle

Creating the cluster is asynchronous. After you request initialization, the cluster moves through
these states:

| Status | Meaning |
|---|---|
| `Creating` | Request accepted, work is starting |
| `DeployingSail` | The driver is rolling out |
| `Active` | Ready — SQL engine registered, Flight SQL endpoint available |
| `Degraded` | The driver is not ready; check the status message |
| `Stopped` | Stopped by a user or by auto-stop; nothing runs until it is started again |
| `Starting` | A start was requested; the driver is coming back |
| `CreationFailed` | Creation failed — see the status message |
| `Deleting` / `DeletionFailed` | Asynchronous deletion in progress / failed |

### What you can do

- **Create a cluster** — a name (lowercase, starts with a letter, at most 40 characters, unique in
  the workspace, not containing `-driver` or `-worker`), driver CPU/memory and worker pool sizing (max workers, per-worker CPU/memory,
  idle timeout, task slots). The engine image is the app's pinned Sail version.
- **Get the cluster** — including lifecycle status and status messages.
- **Update resources** — change driver and worker sizing of an Active cluster; the driver is rolled.
- **Get endpoints** — the Flight SQL endpoint (port 32010, cluster-internal) and the registered SQL
  engine name.
- **Inspect instances** — status and log tails of the driver and workers.
- **Stop / start** — stopping scales the driver to zero and stops its workers; nothing runs (and
  nothing is billed for compute) until you start it again. Starting renews the cluster's token and
  brings the driver back with the current sizing. Sizing can be changed while stopped.
- **Auto-stop** — optional, per cluster: stop the cluster after a chosen idle time (5 minutes to
  7 days) during which no worker ran (workers start for distributed queries and tasks; a cluster with 0 max workers counts as always idle). Changing auto-stop does not restart the cluster.
- **Delete a cluster** — removes its driver, workers, service account and SQL engine
  registration.

### Cluster service account and data access

Each cluster runs as its own Tangram **service account** (shown on the cluster page). It is the
identity Sail presents to the catalogs it reads and writes. Before the engine can use a table, a
workspace admin grants that service account the catalog app's `reader` and/or `writer` roles
(Iceberg, Delta Lake) on the databases it may touch — in this workspace or in another one. Users never act as this identity directly:
every statement goes through the SQL proxy, which checks the user's own dataset privileges before
forwarding it.

## Applications (PySpark jobs)

Besides the interactive cluster, the app runs **PySpark applications as batch jobs**. An
application is a `SailApplication` resource of the workspace; it owns a folder for its files and a
service account its runs use to reach the catalogs.

### Define an application

- **Name** — lowercase letters, digits and dashes.
- **Main file** — the file name of the Python file that starts the job, e.g. `main.py`.
- **Arguments and environment** — passed to every run as `sys.argv` and env (a run can override both).
- **Driver sizing** and **max duration** — the run's driver; a run that exceeds the duration is failed.
- **Workers** (optional) — without workers the job runs inside the driver (local mode). With
  workers, the driver starts up to *max workers* workers on demand; *max
  workers × task slots* must cover the job's partitions.
- **State store** (streaming applications) — real-time queries keep their state in memory by
  default. Turn on RocksDB for large state: it lives on a scratch disk of the run pod and its workers
  (the node's disk), optionally capped by a size limit; a pod over the limit is restarted. Checkpoints
  stay the durable copy, so a restarted run reloads its state. Micro-batch queries always use memory.

### Files

Upload the application's files as versioned **libs**: `PyFile` (Python sources, placed in the run's
working directory so they import each other), `Wheel` (installed with pip before the job starts) or
`File` (copied as-is). Versions are `MAJOR.MINOR.PATCH` and only increase; a run always takes the
**latest version of each lib**. Record the git repository, branch and commit with an upload to keep
provenance. A version referenced by an active run cannot be deleted until the run ends. Source and
text files (Python, Scala, Java, SQL, config) can be previewed in the app.

Files are stored in a Tangram folder on the app's bucket, owned by the application: whoever may
run or update the application can read or write its files through the platform too.

### Runs

- **Run** — starts the job; optional per-run arguments, environment
  and worker sizing. The job's `spark` session is ready when the main file starts; the workspace's
  catalogs are reachable by name, `<catalog>.<database>.<table>`, with the application's service
  account (grant it the catalog app's `reader`/`writer` roles first). Each run has its own page.
- **Service-account token** — the catalogs authenticate with the run's token, a file in
  `/var/run/sail/run/` (default `service-account-token`; its path is in
  `TANGRAM_SERVICE_ACCOUNT_TOKEN_FILE`). It is short-lived (24 hours by default) and renewed in the
  file while the run is active, so read the file each time. A job can use it too, e.g. to call other
  Tangram APIs or a Kafka topic as the application; don't print it. Optionally the driver also gets
  an env var holding the token; a variable cannot be renewed, so such runs keep one token for their
  whole max duration.
- **Status** — `Pending` → `Running` → `Succeeded` / `Failed` / `Cancelled`, with a status message.
- **Cancel** — stops the run and its workers at once.
- **Logs** — driver and worker logs of a run, from the platform's log pipeline.
- **Stats** — the last run's status and run counts per status.

### What you can do

| Action on `SailApplication` | What it allows |
|---|---|
| `Create`, `Get`, `List` | create an application; read and list applications and their files |
| `UpdateLib`, `ListLib`, `ReadLib`, `DeleteLib`, `DeleteLibVersion` | upload files; list them; preview a source file; delete a lib or one of its versions |
| `Run`, `CancelRun`, `ListRuns`, `GetRunLogs`, `GetRunStats` | start and cancel runs; list them; read logs and stats |
| `Delete` | delete the application with its files, service account and run history (refused while a run is active) |

## Streaming applications

Turn on **Streaming** for a job that runs until stopped (Structured Streaming). A streaming
application gets:

- **Alerts** — a failed run opens a critical incident (notify on failures, failures and recoveries,
  or off).
- **Stall detection** — a running run whose driver writes no logs for *Stalled after* minutes
  (default 10; 0 = off) is marked stalled.
- **Restart on failure** — a failed run is resubmitted after 1, 2, 4 … minutes, at most *Max
  restarts* times in a row (a run that stays up 5 minutes without stalling resets the count). Errors
  recognized as not retryable (such as missing classes or too few task slots) are not restarted.
- **Max duration** — raise it for streams (up to 10080 minutes = 7 days); a run past it is failed
  and, with restarts on, resubmitted.

### Reading Kafka

Runs see the workspace's Kafka topics as the `kafka` catalog: `spark.readStream.table("kafka.<cluster>.<topic>")`.
The run reads as the application's service account, so the job holds no Kafka credentials. Grant the
service account the Kafka cluster's *client* role and the *reader* role on the topic. Avro topics
decode with `from_avro(value, schema, {"schemaRegistryUrl": …, "schemaRegistryTokenFile": …})`;
writer schemas come from the registry, so the topic's schema may evolve.

### Micro-batch: Kafka → Delta Lake (or Iceberg)

```python
import os
from pyspark.sql import functions as F

events = (
    spark.readStream.option("startingOffsets", "earliest")
    .option("maxOffsetsPerTrigger", "200000")
    .option("failOnDataLoss", "false")          # continue if Kafka retention removed unread offsets
    .table("kafka.kafka.clickstream")
    .select(F.from_json(F.col("value").cast("string"), "event_id STRING, user_id STRING, ts TIMESTAMP").alias("e"))
    .select("e.*")
    .withColumn("event_date", F.to_date("ts"))
)

spark.sql("CREATE DATABASE IF NOT EXISTS delta.clickstream")
spark.sql("CREATE TABLE IF NOT EXISTS delta.clickstream.events "
          "(event_id STRING, user_id STRING, ts TIMESTAMP, event_date DATE) USING delta PARTITIONED BY (event_date)")

query = (
    events.writeStream.queryName("clickstream_events")   # a stable name keeps its checkpoint
    .format("delta").outputMode("append")
    .trigger(processingTime="30 seconds")
    .toTable("delta.clickstream.events")
)
while not query.awaitTermination(60):   # wait in short steps
    pass
```

Table sinks (Delta Lake, Iceberg) need micro-batch mode. Grant the service account the target
catalog's owner/writer roles on the schema.

### Real-time mode

Real-time mode (`trigger(realTime=…)`) processes records as they arrive within long-running
batches, for sub-second latency. It supports stateless queries, unions, inner and outer stream–stream joins, and
one stateful operator per query (`count`, `sum`, `avg`, `min`, `max` aggregations; no session windows
or `DISTINCT` aggregates), in `update` output mode, and only these sinks: **kafka, console, memory, noop** — not tables and not
`foreachBatch`. Large state can live in the **RocksDB state store** (see *State store* above).

```python
from pyspark.sql import functions as F

counts = (
    spark.readStream.table("kafka.kafka.clickstream")
    .select(F.col("key").cast("string").alias("user_id"))
    .groupBy("user_id").count()
)
query = (
    counts.writeStream.queryName("clicks_per_user")
    .format("console").outputMode("update")
    .trigger(realTime="5 seconds")   # each real-time batch runs this long, then commits its checkpoint
    .start()
)
while not query.awaitTermination(60):
    pass
```

To land real-time results in a table, write them to a Kafka topic and ingest that topic with a
micro-batch application.

### Checkpoints

A streaming query without its own `checkpointLocation` keeps its checkpoint in the application's
run storage under `checkpoints/<queryName>`, the same folder for every run of the application. A new
run, a restart or an updated lib resumes from the last committed batch, as long as the query stays
compatible (changing stateful operators breaks the checkpoint).

- Keep `queryName` stable; a new name starts over (from `startingOffsets`).
- A run that sets any `AWS_*` env keeps its own AWS settings and gets no default checkpoint and no
  Sail UI history; give its queries an explicit, durable `checkpointLocation`.
- Deleting and recreating the application gives it new run storage, so its queries start over.
- Only the latest batches are kept (see *Retention*).
- A `memory` sink does not recover from a checkpoint in real-time (`update`) mode; give such queries
  a new `queryName` or use a durable sink.

## Sail UI

Every run has the **Sail UI** (the run row's *Sail UI* button): jobs, stages, SQL plans, and for
streaming queries their batches, input and processing rates, state and Kafka offsets. Clusters have
it too, while their driver runs.

Finished runs open their **History**: the same pages rendered from the run's event logs, with the
application's earlier runs to compare. Long streaming runs keep only a recent window of history
(see *Retention*).

## Retention

Set per application under **Run history** (each field's info icon explains it); empty fields use the
defaults.

| Setting | Default | What it does |
|---|---|---|
| Keep finished runs for | 30 days | Older finished runs leave the run list with their history. |
| Always keep the newest | 20 runs | Finished runs kept in the list whatever their age. |
| Sail UI history window | 24 h streaming, 168 h batch | The running driver deletes its own history older than this, so long streams stay small. It also deletes ended runs' history once all of it is older, hourly while it runs; the run list follows the two settings above. |
| Checkpoint batches to keep | 100 | Streaming queries keep the checkpoint records (offsets, commits, state) of this many latest batches and delete older ones. |

The first two apply to existing finished runs at the next hourly sweep. The history window and
checkpoint batches apply to runs started after the change; a running stream keeps the values it
started with until it is restarted. Active runs and checkpoint folders are never removed.

## Catalogs

Sail supports both Apache Iceberg and Delta Lake. Sail is the compute; Tangram SQL owns the
catalogs. Tables are addressed by their Tangram SQL
catalog name — `<catalog>.<database>.<table>`, e.g. `iceberg.sales.orders`, `delta.events.clicks`,
or another workspace's catalog such as `finance_iceberg.reports.monthly`.

- Any Iceberg or Delta Lake catalog registered in Tangram SQL can be used, including other workspaces'
  catalogs: grant the engine's (or application's) service account roles there and it works, with
  no cluster change or restart.
- `CREATE TABLE` without `USING` creates the table in the target catalog's format.
- Reads, `INSERT`, `CREATE TABLE … AS SELECT`, `MERGE`, `UPDATE` and `DELETE` work on Iceberg and
  Delta Lake tables alike, and a job or query can read one format and write the other.

## Lineage

Sail jobs record the lineage of every write they commit, shown in the dataset's lineage panel:

- **Tables** — the tables a write read, linked to the table it wrote.
- **Columns** — for each written column, the source columns it comes from.
- **Version** — the table version the write created (Delta Lake version, Iceberg snapshot), with the
  table's commit history.
- **Job** — the application and the run that wrote it, with a link to the run, and the SQL statement
  when the write was SQL.

It covers `INSERT`, `CREATE TABLE … AS SELECT`, DataFrame `writeTo` / `saveAsTable` / `insertInto`,
`MERGE` and `UPDATE`. A write that fails or changes nothing records nothing. Queries sent to a
cluster through the Tangram SQL proxy record their lineage too.

## Querying

The Active cluster is registered as a SQL engine. Connect through the Tangram SQL proxy with any
PostgreSQL client, or pick the engine in a SQL notebook, and run Spark SQL against Iceberg and
Delta Lake tables.

## Trademarks

Sail and LakeSail are trademarks of LakeSail, Inc.; the Sail logo is used unmodified from the
[LakeSail media kit](https://lakesail.com/media-kit/). Apache Spark and Spark are trademarks of the
Apache Software Foundation. This app is built by Tangram and is not affiliated with or endorsed by
LakeSail, Inc. or the Apache Software Foundation.
