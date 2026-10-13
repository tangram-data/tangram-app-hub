# Sail — User Guide

The Sail app runs a [Sail](https://lakesail.com) (LakeSail) engine on Kubernetes: a Spark-compatible
compute engine written in Rust that reads and writes the workspace's Iceberg lakehouse. The app
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
- **Delete a cluster** — removes its driver, workers, service account and SQL engine
  registration.

### Cluster service account and data access

Each cluster runs as its own Tangram **service account** (shown on the cluster page). It is the
identity Sail presents to the workspace's Iceberg REST catalog. Before the engine can read or
write Iceberg tables, a workspace admin grants that service account the Iceberg app's `reader`
and/or `writer` roles on the databases it may touch. Users never act as this identity directly:
every statement goes through the SQL proxy, which checks the user's own dataset privileges before
forwarding it.

## Applications (PySpark jobs)

Besides the interactive cluster, the app runs **PySpark applications as batch jobs**. An
application is a `SailApplication` resource of the workspace; it owns a folder for its files and a
service account its runs use to reach the Iceberg catalog.

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
provenance. A version referenced by an active run cannot be deleted until the run ends.

Files are stored in a Tangram folder on the app's bucket, owned by the application: whoever may
run or update the application can read or write its files through the platform too.

### Runs

- **Run** — starts a Kubernetes Job in the app's namespace; optional per-run arguments, environment
  and worker sizing. The job's `spark` session is ready when the main file starts; Iceberg tables are
  reachable as `iceberg.<database>.<table>` with the application's service account (grant it the
  Iceberg app's `reader`/`writer` roles first).
- **Status** — `Pending` → `Running` → `Succeeded` / `Failed` / `Cancelled`, with a status message.
- **Cancel** — stops the Job and its workers at once.
- **Logs** — driver and worker logs of a run, from the platform's log pipeline.
- **Stats** — the last run's status and run counts per status.

### What you can do

| Action on `SailApplication` | What it allows |
|---|---|
| `Create`, `Get`, `List` | create an application; read and list applications and their files |
| `UpdateLib`, `ListLib`, `DeleteLib`, `DeleteLibVersion` | upload files; list them; delete a lib or one of its versions |
| `Run`, `CancelRun`, `ListRuns`, `GetRunLogs`, `GetRunStats` | start and cancel runs; list them; read logs and stats |
| `Delete` | delete the application with its files, service account and run history (refused while a run is active) |

## Querying

The Active cluster is registered as a SQL engine. Connect through the Tangram SQL proxy with any
PostgreSQL client, or pick the engine in a SQL notebook, and run Spark SQL against Iceberg tables.
