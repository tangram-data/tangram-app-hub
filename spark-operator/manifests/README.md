# Spark Operator — User Guide

The Spark Operator manages Apache Spark applications and clusters on Kubernetes. It handles the full lifecycle: provisioning compute clusters, registering Spark applications, managing versioned libraries, submitting and monitoring runs, and accessing logs and the Spark UI.

---

## Clusters

A cluster is a Kubernetes-backed Spark compute environment. You must have an `Active` cluster before you can run any Spark application.

### Lifecycle

Provisioning a cluster is asynchronous. After you request creation, the cluster moves through these states:

| Status | Meaning |
|---|---|
| `Creating` | Provisioning in progress — cluster is not yet usable |
| `Active` | Ready to accept runs |
| `CreationFailed` | Provisioning failed — cluster can be retried |
| `Deleting` | Deletion in progress |
| `DeletionFailed` | Deletion encountered an error |

### What you can do

**Create a cluster** — specify a name, node size, disk size, and worker count bounds (min, initial, max). Cluster names must be lowercase alphanumeric with hyphens, start with a letter, and be at most 32 characters.

Available node sizes: `XS`, `S`, `M`, `L`, `XL`, `XXL`

**Retry a failed cluster** — if a cluster is in `CreationFailed` state, you can retry provisioning it without deleting and recreating it.

**List clusters / find a cluster** — see all clusters or look up a specific one by name, including its current status.

**Inspect cluster nodes** — view the actual hardware of each node: CPU cores, memory (GB), storage (GB), and cloud instance type.

**Delete a cluster** — deletion is asynchronous. The cluster moves to `Deleting` and is removed once deprovisioned. If deletion fails, the status becomes `DeletionFailed`.

---

## Applications

An application is a reusable Spark job template. It captures everything needed to run a job: the container image, main class or entry point, JARs, Python/R files, Spark configuration, and driver/executor resource requirements.

You register an application once, then run it as many times as needed — optionally overriding Spark configuration at run time.

### What you can do

**Register an application** — provide the container image, entry point, resource specs (driver cores/memory, executor count/cores/memory), static JARs/files, and any default Spark configuration.

**View an application** — retrieve the full spec of a registered application.

**List all applications** — see every registered application.

**Delete an application** — removes the application record and its associated library storage. Active runs are not affected.

---

## Application Libraries

Libraries (JARs, Python files, R files) are versioned artifacts stored in object storage. When a run is submitted, the latest version of each library registered for the application is automatically included in the Spark job classpath — you don't need to reference them manually in the application spec.

The latest version of every library uploaded will be automatically configured to be part of jar files, py files or Spark R files when running application.

### Versioning rules

- Versions must follow **semantic versioning**: `MAJOR.MINOR.PATCH` (e.g. `1.0.0`)
- Each new version must be strictly greater than the current latest — uploading the same or an older version is rejected
- Versions are compared numerically, not lexicographically (so `1.10.0` > `1.9.0`)
- Versioning is independent per library name within an application

### Git provenance

When uploading a library, you can optionally record where the artifact came from: repository URL, branch (defaults to `main`), and commit hash. This is stored alongside the version for traceability.

### What you can do

**Upload a new library version** — upload a file for a named library. Provide the library type (`Jar`, `PyFile`, or `RFile`) and optionally the git provenance metadata. The file's original filename is preserved.

Example upload:
```bash
curl -X POST \
  "http://<host>/api/v1/applications/my-app/libs/my-lib/versions/1.0.0?libType=Jar&gitRepo=github.com/org/repo&gitBranch=main&gitCommitHash=abc123" \
  -F "file=@my-lib-1.0.0.jar"
```

**List all libraries for an application** — shows each library name with its latest version.

**List versions of a library** — see the full version history of a specific library, including git provenance for each version.

**Delete a specific library version** — removes a single version from storage and the registry.

**Delete all versions of a library** — removes every version of a library from storage and the registry.

---

## Runs

A run submits a registered application to an active cluster for execution. Each run gets a unique `runId` and is tracked through its full lifecycle.

When a run is submitted, the operator automatically resolves the latest version of each library registered for the application and includes them in the job — no manual coordination needed.

### Lifecycle

| Status | Meaning |
|---|---|
| `Pending` | Submitted to the cluster, waiting for the driver to start |
| `Running` | Spark job is actively executing |
| `Succeeded` | Job completed successfully |
| `Failed` | Job completed with an error — a status message with the failure reason is recorded |
| `Cancelled` | Cancelled by the user before or during execution |
| `Unknown` | Status could not be determined |

Terminal runs (`Succeeded`, `Failed`, `Cancelled`) have an `endedAt` timestamp recorded. Failed runs include a `statusMessage` with the error from the Spark operator.

### What you can do

**Submit a run** — choose which cluster to run on and optionally override Spark configuration (e.g. increase executor count for a specific run). The operator handles creating the Kubernetes custom resource, setting up credentials, and tracking status automatically.

**Monitor run status** — poll or retrieve the full run details at any point, including status, start time, end time, and error message.

**List runs for an application** — see all runs for a given application, optionally filtered by time range.

**List runs for a cluster** — see all runs that have executed on a specific cluster, optionally filtered by time range.

**View run statistics** — see aggregated counts per status (Pending, Running, Succeeded, Failed, etc.) across all runs of an application.

**Cancel a run** — cancel a run that is still `Pending` or `Running`. Already-completed runs cannot be cancelled.

**Access the Spark UI** — while a run is active, the Spark driver UI is accessible and when a run terminates, Spark history UI will be available as well.

---

## Logs

Spark driver and executor logs are collected and indexed, and can be queried per run.

### What you can do

**Query logs for a run** — retrieve logs from the driver or executor pods for a specific run. Supports filtering by:
- Component: `Driver` or `Executor`
- Time range (start/end timestamp)
- Keyword search
- Result limit

Logs are returned sorted by timestamp descending. The response includes the total number of matching entries (`numHits`) before the limit is applied, along with each log line's timestamp, message, and container name.
