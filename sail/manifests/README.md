# Sail — User Guide

The Sail app runs a [Sail](https://lakesail.com) (LakeSail) engine on Kubernetes: a Spark-compatible
compute engine written in Rust that reads and writes the workspace's Iceberg lakehouse. The app
deploys one Flight SQL driver that starts worker pods on demand and removes them when idle, and
registers the cluster as a SQL engine so it is queryable through the Tangram SQL proxy with any
PostgreSQL client, from SQL notebooks, dashboards and flows.

The app manages **one cluster per workspace deployment** (fixed name `sail`), deployed into the app's
own Kubernetes namespace. An idle cluster costs only the driver pod.

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

- **Initialize the cluster** — driver CPU/memory, worker pool sizing (max workers, per-worker
  CPU/memory, idle timeout, task slots) and optionally a Sail image override.
- **Get the cluster** — including lifecycle status and status messages.
- **Update resources** — change driver and worker sizing of an Active cluster; the driver is rolled.
- **Get endpoints** — the Flight SQL endpoint (port 32010, cluster-internal) and the registered SQL
  engine name.
- **Inspect instances** — status and log tails of the driver and worker pods.
- **Delete the cluster** — removes the driver, workers, the engine's service account and the SQL
  engine registration.

### Engine identity and data access

The engine runs as a Tangram **service account** owned by the cluster (shown in the endpoints). It
is the identity Sail presents to the workspace's Iceberg REST catalog. Before the engine can read or
write Iceberg tables, a workspace admin grants that service account the Iceberg app's `reader`
and/or `writer` roles on the databases it may touch. Users never act as this identity directly:
every statement goes through the SQL proxy, which checks the user's own dataset privileges before
forwarding it.

### Security

Sail has no client authentication. The Flight SQL endpoint is reachable only from the platform
namespace (the SQL proxy) and the app's own namespace, and is never exposed through the UI. The
driver runs under the platform's restricted workload service account and spawns workers under an
unprivileged worker account; a cluster-wide admission policy prevents those pods from mounting
Secrets or escalating privileges.

## Querying

The Active cluster is registered as a SQL engine. Connect through the Tangram SQL proxy with any
PostgreSQL client, or pick the engine in a SQL notebook, and run Spark SQL against Iceberg tables.
