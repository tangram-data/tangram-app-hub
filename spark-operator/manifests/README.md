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

- **Name** — lowercase letters, digits and dashes.
- **Main file** — the file name of the JAR or Python file that starts the job (`etl.jar`,
  `main.py`); for a JAR without a `Main-Class` manifest also the **main class**.
- **Arguments, Spark settings and environment** — passed to every run (a run can override them).
- **Driver sizing** and **max duration** — the run pod; a run that exceeds the duration is failed.
- **Executors** (optional) — without executors the job runs in local mode inside the driver pod.
  With executors, the driver requests up to *max executors* pods on demand (dynamic allocation).

### Files

Upload the application's files as versioned **libs**: `Jar` (added to `--jars`, or the main JAR),
`PyFile` (added to `--py-files`, or the main script), `PyArchive` (`.zip`/`.egg` of pure-Python
code, added to `--py-files`; wheels are not supported, zip the package instead) or `File` (shipped with `--files`). Versions are
`MAJOR.MINOR.PATCH` and only increase; a run always takes the **latest version of each lib**.
Record the git repository, branch and commit with an upload to keep provenance. A version
referenced by an active run cannot be deleted until the run ends.

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

### What you can do

| Action on `SparkApplication` | What it allows |
|---|---|
| `Create`, `Get`, `List` | create an application; read and list applications and their files |
| `UpdateLib`, `ListLib`, `DeleteLib`, `DeleteLibVersion` | upload files; list them; delete a lib or one of its versions |
| `Run`, `CancelRun`, `ListRuns`, `GetRunLogs`, `GetRunStats` | start and cancel runs; list them; read logs and stats |
| `Delete` | delete the application with its files, service account and run history (refused while a run is active) |
