# Spark — User Guide

The Spark app runs [Apache Spark](https://spark.apache.org) 4.1 on the platform's own Kubernetes
cluster, in the app's namespace — no separate cluster to provision. It offers two ways to use
Spark over the workspace's Iceberg lakehouse:

- **Clusters** — long-running Spark Connect servers for interactive work (PySpark, notebooks).
  Each cluster is one driver pod that starts executor pods on demand and releases them when idle.
- **Applications** — JAR or PySpark jobs. Every run is a Kubernetes Job whose pod is the Spark
  driver; it runs locally in that pod or requests executor pods on demand.

A workspace can run **several clusters**, each with its own name, sizing and Spark settings. An idle
cluster costs only its driver pod.

---

## Clusters

### Lifecycle

Creating a cluster is asynchronous. After you request it, the cluster moves through these states:

| Status | Meaning |
|---|---|
| `Creating` | Request accepted, work is starting |
| `DeployingSpark` | The driver is rolling out |
| `Active` | Ready — the Spark Connect endpoint is available |
| `Degraded` | The driver pod is not ready; check the status message |
| `Stopped` | Stopped by a user or by auto-stop; no pods run until it is started again |
| `Starting` | A start was requested; the driver is coming back |
| `CreationFailed` | Creation failed — see the status message |
| `Deleting` / `DeletionFailed` | Asynchronous deletion in progress / failed |

### What you can do

- **Create a cluster** — a name (lowercase, starts with a letter, at most 40 characters, unique in
  the workspace, not containing `-driver` or `-exec`), driver CPU/memory, executor sizing (max
  executors, per-executor CPU/memory, cores, idle timeout) and optional Spark settings. With max
  executors `0` the cluster runs in local mode inside the driver pod.
- **Get the cluster** — including lifecycle status and status messages.
- **Update resources** — change driver, executor sizing and Spark settings of an Active cluster;
  the driver is restarted (open sessions are lost).
- **Get endpoints** — the Spark Connect URL (`sc://<cluster>-connect.<namespace>.svc.cluster.local:15002`,
  reachable inside the Kubernetes cluster only) and the Spark UI.
- **Spark UI** — the live driver UI (jobs, stages, SQL, executors), served by the app.
- **Inspect instances** — status and log tails of the driver and executor pods.
- **Stop / start** — stopping scales the driver to zero and stops its executors; nothing runs (and
  nothing is billed for compute) until you start it again. Starting renews the cluster's token and
  brings the driver back with the current sizing. Sizing can be changed while stopped.
- **Auto-stop** — optional, per cluster: stop the cluster after a chosen idle time (5 minutes to
  7 days) during which no Spark job ran or finished (Spark Connect sessions alone do not count). Changing auto-stop does not restart the cluster.
- **Delete a cluster** — removes its driver, executors and service account.

```python
from pyspark.sql import SparkSession
spark = SparkSession.builder.remote("sc://<cluster>-connect.<namespace>.svc.cluster.local:15002").getOrCreate()
spark.sql("SELECT * FROM iceberg.sales.orders LIMIT 10").show()
```

Spark Connect has no client authentication: every session on a cluster acts as the cluster's
service account. Share a cluster only with users who may use that account's data access.

### Tangram folders

Jobs and Connect sessions can read and write files in Tangram folders through `to://` paths, e.g.
`spark.read.parquet("to://<workspace>/<folder>/events/")`, as the cluster's or application's service
account. Grant that account access to the folder first.

### Spark settings

Clusters and applications accept extra Spark settings (`spark.sql.shuffle.partitions`,
`spark.jars.packages`, …). The app manages the Kubernetes wiring, driver networking, executor
sizing and the `iceberg` catalog, so `spark.master`, `spark.kubernetes.*`,
`spark.sql.catalog.iceberg*`, `spark.driver.host/port/memory*/cores`, `spark.executor.memory*/cores`,
`spark.executor.pyspark.memory`, `spark.memory.offHeap.*`, `spark.hadoop.fs.to.*` and similar keys are refused.

### Cluster service account and data access

Each cluster runs as its own Tangram **service account** (shown on the cluster page). It is the
identity Spark presents to the workspace's Iceberg REST catalog (`iceberg`, also the session's
default catalog); storage credentials are vended per table by the catalog. Before the cluster can
read or write Iceberg tables, a workspace admin grants that service account the Iceberg app's
`reader` and/or `writer` roles on the databases it may touch.

## Querying with SQL

Each cluster is registered as a SQL engine of the workspace. Connect through the Tangram SQL proxy
with any PostgreSQL client, or pick the engine in a SQL notebook, dashboard or component, and run
Spark SQL against Iceberg tables (`database.table`); the proxy forwards statements over Spark
Connect after checking the user's own dataset privileges. Bound parameters are supported. A
cluster stopped for idleness starts on the first query (the query waits, typically a minute or
two); one a user stopped stays stopped and queries fail until it is started.

## Applications (batch jobs)

An application is a `SparkApplication` resource of the workspace; it owns a folder for its files
and a service account its runs use to reach the Iceberg catalog.

### Define an application

- **Streaming job** — off: a batch job that runs to completion; on: runs Structured Streaming queries
  until stopped (see *Streaming jobs*).
- **Name** — lowercase letters, digits and dashes.
- **Main file** — the file name of the JAR or Python file that starts the job (`etl.jar`,
  `main.py`); for a JAR without a `Main-Class` manifest also the **main class**.
- **Arguments, Spark settings and environment** — passed to every run (a run can override them).
- **Driver sizing** and **max duration** — the run pod; a run that exceeds the duration is failed.
- **Executors** (optional) — without executors the job runs in local mode inside the driver pod.
  With executors, the driver requests up to *max executors* pods on demand (dynamic allocation).
- **Service-account token** — every run gets its service account's token as a file in
  `/var/run/spark/run/` (name configurable, default `service-account-token`; its path is always in
  `TANGRAM_SERVICE_ACCOUNT_TOKEN_FILE`). The token is short-lived (24 hours by default) and renewed
  in the file while the run is active, so read the file each time you need it. The Iceberg catalog,
  `to://` paths and lineage use it automatically; jobs can use it too, e.g. as the OAUTHBEARER token
  of the Kafka app's Tangram-token listener. Optionally the driver also gets an env var holding the
  token (e.g. `TANGRAM_SERVICE_ACCOUNT_TOKEN`); a variable cannot be renewed, so such runs keep one
  token valid for their whole max duration. It comes from the run's Secret and is never a Spark
  setting; don't print the environment in logs.

Settings can be changed later (**Edit** on the application page); the next run uses them, runs in
progress keep the settings they started with. The name is fixed.

### Files

Upload the application's files as versioned **libs**: `Jar` (added to `--jars`, or the main JAR),
`PyFile` (added to `--py-files`, or the main script), `PyArchive` (`.zip`/`.egg` of pure-Python
code, added to `--py-files`; wheels are not supported, zip the package instead) or `File` (shipped with `--files`). Versions are
`MAJOR.MINOR.PATCH` and only increase; a run always takes the **latest version of each lib**.
Record the git repository, branch and commit with an upload to keep provenance. A version
referenced by an active run cannot be deleted until the run ends. Source and text files (Python,
Scala, Java, SQL, config) can be previewed in the app (files up to 16 MiB; the first 1 MiB is shown).

Files are stored in a Tangram folder on the app's bucket, owned by the application: whoever may
run or update the application can read or write its files through the platform too.

### Runs

- **Run** — starts a Kubernetes Job in the app's namespace; optional per-run arguments, Spark
  settings, environment and executor sizing. Iceberg tables are reachable as
  `iceberg.<database>.<table>` and Tangram folders as `to://<workspace>/<folder>/…`, both with the
  application's service account (grant it the Iceberg app's `reader`/`writer` roles or folder access
  first).
- **Status** — `Pending` → `Running` → `Succeeded` / `Failed` / `Cancelled`, with a status message.
- **Spark UI** — the live driver UI while the run is running.
- **Cancel** — stops the Job and its executors at once.
- **Logs** — driver and executor logs of a run, from the platform's log pipeline.
- **Stats** — the last run's status and run counts per status.

### Notifications and retries

Set on the **Notifications and restarts** tab of the application (Edit):

- **Notify on** (default: failures) — a failed run opens an incident on the application in AI SRE and
  the inbox; *failures and recovery* also resolves it when a later run succeeds; *off* stays quiet.
- **Severity** (default: critical for streaming, warning for batch) — critical incidents are also
  emailed to Ops admins; Slack gets incidents at or above the workspace's minimum Slack severity.
  Pick *Critical* for a batch job whose failure someone must see right away.
- **Retry on failure** (batch, off by default) — resubmits a failed run after 1, 2, 4 … minutes, at
  most *Max retries* times in a row. A newer run (yours or a Flow's) takes over: the pending retry is
  dropped and the count starts again. Errors a retry would repeat (bad SQL, missing Python modules)
  are not retried. Turn it on only when the job is safe to rerun after a partial write.
- Streaming jobs also get **Stalled after** (no driver logs for that long marks the run stalled) and
  **Restart on failure** (a run up 5 minutes resets the count).

### Streaming jobs

Turn on **Streaming job** for an application that runs Structured Streaming queries. Its queries then
checkpoint under the application's folder by default,
`to://<workspace>/<application folder>/checkpoints/<query name>` (shown on the Edit page), and the
application runs one at a time, so two runs never share a checkpoint. Name each query so a new run
resumes where the last one stopped:

```python
events.writeStream.queryName("clickstream").toTable("iceberg.streaming.clickstream")
```

An unnamed query gets a new checkpoint every run. For batch jobs, Spark's temporary
checkpoints apply as usual. A `checkpointLocation` option, or
`spark.sql.streaming.checkpointLocation` in the application's Spark settings, overrides the default.
Runs also get the folder as `TANGRAM_SPARK_APP_FOLDER` for other state. To start a query over,
delete its checkpoint folder. Set the max duration to how long the stream should run.

### Kafka topics

Runs see the workspace's Kafka topics as the read-only `kafka` catalog,
`spark.readStream.table("kafka.<cluster>.<topic>")`, read as the application's service account (grant it the
Kafka cluster's *client* role and the topic's *reader* role). Decode the `value` column with `from_json` or, for
Avro topics, `from_avro` (included in the image). The Kafka app writes Avro in the Confluent wire format and Spark's
`from_avro` has no schema registry, so cut the 5-byte header and pass the topic's schema:

```python
from pyspark.sql import functions as F
from pyspark.sql.avro.functions import from_avro
decoded = from_avro(F.expr("substring(value, 6, length(value) - 5)"), avro_schema_json)
```

This decodes every message with one schema, so it assumes the topic has a single writer schema; after a schema
change, messages still retained under the old schema may not decode with the new one.

Lineage records a column against a field of the topic's schema when the column is that decoded field (directly or
cast), the query reads one topic without a union, and the topic's schema has the field; otherwise the column stays
attributed to `value`.

### What you can do

| Action on `SparkApplication` | What it allows |
|---|---|
| `Create`, `Get`, `List` | create an application; read and list applications and their files |
| `Update` | change the application's settings (entry point, sizing, Spark settings, env, token) |
| `UpdateLib`, `ListLib`, `ReadLib`, `DeleteLib`, `DeleteLibVersion` | upload files; list them; preview a source file; delete a lib or one of its versions |
| `Run`, `CancelRun`, `ListRuns`, `GetRunLogs`, `GetRunStats` | start and cancel runs; list them; read logs and stats |
| `Delete` | delete the application with its files, service account and run history (refused while a run is active) |

## Trademarks

Apache, Apache Spark, Spark and the Spark logo are trademarks of the
[Apache Software Foundation](https://www.apache.org/foundation/marks/). This app is built by Tangram
and is not affiliated with or endorsed by the Apache Software Foundation.
