# StarRocks — User Guide

The StarRocks app manages a [StarRocks](https://www.starrocks.io/) OLAP cluster on Kubernetes. It
handles the full lifecycle: deploying the cluster through the official StarRocks Kubernetes
Operator, initializing shared-data object storage, and registering the cluster as a SQL engine so
it is queryable through the Tangram SQL proxy with any PostgreSQL client.

The app manages **one cluster per workspace deployment** (fixed name `starrocks`), deployed in
**shared-data mode** into the app's own Kubernetes cluster: stateless compute (CN) nodes with data
on the workspace's provisioned object storage. Storage is entirely app-managed — the default
storage volume is created automatically once the cluster is up, and credentials are never persisted
by the app. The FE catalog metadata is kept on a persistent volume, so it survives pod restarts and
scaling operations.

---

## Cluster

### Lifecycle

Creating the cluster is asynchronous. After you request initialization, the cluster moves through
these states:

| Status | Meaning |
|---|---|
| `Creating` | Request accepted, work is starting |
| `InstallingOperator` | Waiting for the StarRocks operator to be ready |
| `DeployingStarRocks` | StarRocks FE/CN components are rolling out |
| `Active` | Ready — SQL engine registered, endpoints available |
| `Degraded` | A component reports failure; check the status message |
| `Suspended` | Compute scaled to zero after the idle timeout; resumes on the next SQL connection |
| `Resuming` | Compute scaling back up after a suspend; flips to `Active` once nodes are ready |
| `CreationFailed` | Creation failed — see the status message |
| `Deleting` / `DeletionFailed` | Asynchronous deletion in progress / failed |

### What you can do

- **Initialize the cluster** — FE replicas (1 or 3) and sizing, compute sizing with either a fixed
  replica count or autoscaling, and an optional idle-suspend timeout.
- **Get the cluster** — including lifecycle status and status messages.
- **Update resources** — change FE/compute sizing, autoscaling, and idle-suspend settings of an
  Active cluster; the operator rolls the change out.
- **Scale compute** — change the CN replica count of an Active cluster. Rejected while autoscaling
  is enabled (the autoscaler owns the count — adjust the min/max range instead).
- **Get endpoints** — the FE MySQL endpoint (port 9030), FE HTTP endpoint (port 8030), and the
  registered SQL engine name for use with the SQL proxy. The FE stays cluster-internal; queries go
  through the SQL proxy.
- **Inspect instances** — status and log tails of the cluster's FE/CN pods for debugging.
- **Delete the cluster** — removes the StarRocks cluster, its persistent volumes, and the SQL
  engine registration.

### Compute autoscaling

Enable autoscaling to let a Kubernetes HPA drive the CN replica count between a min/max range based
on CPU utilization (configurable target). Scale-to-zero via autoscaling is not supported — the
minimum is 1 instance. New CN nodes start with a cold data cache, so expect briefly slower queries
right after a scale-out.

### Suspend when idle

With an idle timeout configured, the app watches query activity and scales compute to zero after
the timeout (status `Suspended`). The FE stays up, so the catalog remains browsable and metadata
queries keep working — only data-scanning compute is released. The next SQL connection wakes the
cluster automatically; the first connection blocks while compute comes back (typically 1–3
minutes), then queries run normally.

## Querying

The Active cluster is registered as a SQL engine. Connect through the Tangram SQL proxy with any
PostgreSQL client and select the engine to run SQL against StarRocks.

## Kafka ingestion (routine loads)

The Ingestion tab creates and manages StarRocks routine load jobs — continuous ingestion from a
Kafka topic into a table — without writing SQL. A form describes the job (target database/table,
brokers, topic, start offset, JSON/CSV mapping, optional row filter and Kafka client properties
such as SASL credentials); the app renders the `CREATE ROUTINE LOAD` statement (previewable) and
executes it on the cluster FE. Each created job is registered as a `RoutineLoad` resource in the
workspace resource registry.

The job list shows live state (`RUNNING`, `PAUSED`, `UNSTABLE`, ...), loaded/error row counters,
and per-partition consumed offsets with lag against the newest source offsets. Jobs can be paused
and resumed in place; stopping a job is permanent and removes its registry entry.
