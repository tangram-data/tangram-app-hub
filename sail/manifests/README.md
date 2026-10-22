# Sail — User Guide

The Sail app runs a [Sail](https://lakesail.com) (LakeSail) engine on Kubernetes: a Spark-compatible
compute engine written in Rust that reads and writes Iceberg and Delta tables of Tangram SQL catalogs. The app
deploys one Flight SQL driver that starts worker pods on demand and removes them when idle, and
registers the cluster as a SQL engine so it is queryable through the Tangram SQL proxy with any
PostgreSQL client, from SQL notebooks, dashboards and flows.

A workspace can run **several clusters**, each with its own name and sizing, all deployed into the
app's own Kubernetes namespace and each registered as its own SQL engine. An idle cluster costs
only its driver pod.

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
| `Degraded` | The driver pod is not ready; check the status message |
| `Stopped` | Stopped by a user or by auto-stop; no pods run until it is started again |
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
- **Inspect instances** — status and log tails of the driver and worker pods.
- **Stop / start** — stopping scales the driver to zero and stops its workers; nothing runs (and
  nothing is billed for compute) until you start it again. Starting renews the cluster's token and
  brings the driver back with the current sizing. Sizing can be changed while stopped.
- **Auto-stop** — optional, per cluster: stop the cluster after a chosen idle time (5 minutes to
  7 days) during which no worker pod ran (workers start for distributed queries and tasks; a cluster with 0 max workers counts as always idle). Changing auto-stop does not restart the cluster.
- **Delete a cluster** — removes its driver, workers, service account and SQL engine
  registration.

### Cluster service account and data access

Each cluster runs as its own Tangram **service account** (shown on the cluster page). It is the
identity Sail presents to the catalogs it reads and writes. Before the engine can use a table, a
workspace admin grants that service account the catalog app's `reader` and/or `writer` roles
(Iceberg, Delta) on the databases it may touch — in this workspace or in another one. Users never act as this identity directly:
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
- **Driver sizing** and **max duration** — the run pod; a run that exceeds the duration is failed.
- **Workers** (optional) — without workers the job runs inside the driver pod (local mode). With
  workers, the pod becomes the job's driver and starts up to *max workers* pods on demand; *max
  workers × task slots* must cover the job's partitions.

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

- **Run** — starts a Kubernetes Job in the app's namespace; optional per-run arguments, environment
  and worker sizing. The job's `spark` session is ready when the main file starts; the workspace's
  catalogs are reachable by name, `<catalog>.<database>.<table>`, with the application's service
  account (grant it the catalog app's `reader`/`writer` roles first). Each run has its own page.
- **Status** — `Pending` → `Running` → `Succeeded` / `Failed` / `Cancelled`, with a status message.
- **Cancel** — stops the Job and its workers at once.
- **Logs** — driver and worker logs of a run, from the platform's log pipeline.
- **Stats** — the last run's status and run counts per status.

### What you can do

| Action on `SailApplication` | What it allows |
|---|---|
| `Create`, `Get`, `List` | create an application; read and list applications and their files |
| `UpdateLib`, `ListLib`, `ReadLib`, `DeleteLib`, `DeleteLibVersion` | upload files; list them; preview a source file; delete a lib or one of its versions |
| `Run`, `CancelRun`, `ListRuns`, `GetRunLogs`, `GetRunStats` | start and cancel runs; list them; read logs and stats |
| `Delete` | delete the application with its files, service account and run history (refused while a run is active) |

## Catalogs

Sail is the compute; Tangram SQL owns the catalogs. Tables are addressed by their Tangram SQL
catalog name — `<catalog>.<database>.<table>`, e.g. `iceberg.sales.orders`, `delta.events.clicks`,
or another workspace's catalog such as `finance_iceberg.reports.monthly`.

- Any Iceberg or Delta catalog registered in Tangram SQL can be used, including other workspaces'
  catalogs: grant the engine's (or application's) service account roles there and it works, with
  no cluster change or restart.
- `CREATE TABLE` without `USING` creates the table in the target catalog's format.
- Reads, `INSERT`, `CREATE TABLE … AS SELECT`, `MERGE`, `UPDATE` and `DELETE` work on Iceberg and
  Delta tables alike.

## Lineage

Sail jobs record the lineage of every write they commit, shown in the dataset's lineage panel:

- **Tables** — the tables a write read, linked to the table it wrote.
- **Columns** — for each written column, the source columns it comes from.
- **Version** — the table version the write created (Delta version, Iceberg snapshot), with the
  table's commit history.
- **Job** — the application and the run that wrote it, with a link to the run, and the SQL statement
  when the write was SQL.

It covers `INSERT`, `CREATE TABLE … AS SELECT`, DataFrame `writeTo` / `saveAsTable` / `insertInto`,
`MERGE` and `UPDATE`. A write that fails or changes nothing records nothing. Queries sent to a
cluster through the Tangram SQL proxy record their lineage too.

## Querying

The Active cluster is registered as a SQL engine. Connect through the Tangram SQL proxy with any
PostgreSQL client, or pick the engine in a SQL notebook, and run Spark SQL against Iceberg and
Delta tables.

## Trademarks

Sail and LakeSail are trademarks of LakeSail, Inc.; the Sail logo is used unmodified from the
[LakeSail media kit](https://lakesail.com/media-kit/). Apache Spark and Spark are trademarks of the
Apache Software Foundation. This app is built by Tangram and is not affiliated with or endorsed by
LakeSail, Inc. or the Apache Software Foundation.
