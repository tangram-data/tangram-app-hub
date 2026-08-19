# Strimzi

Provision and operate Apache Kafka clusters on Kubernetes through a namespace-confined
[Strimzi](https://strimzi.io) Cluster Operator (KRaft mode — no ZooKeeper).

## What you get

- **One Kafka cluster per workspace deployment** (fixed name `kafka`): a controller node pool
  (1 or 3 replicas, KRaft quorum) and a broker node pool, each with per-pod CPU/memory and
  persistent disks. Creation is asynchronous — poll the cluster until it reaches `Active`
  (`Creating → InstallingOperator → DeployingKafka → Active`).
- **Topics** managed declaratively (`KafkaTopic` custom resources reconciled by the Strimzi Topic
  Operator): create with partitions/replicas/config, grow partitions, update config, delete.
- **Users** with SCRAM-SHA-512 credentials (`KafkaUser` custom resources): an admin user is created
  with the cluster, further users on demand; credentials are materialized by the User Operator and
  surfaced only through the authorized credentials actions.
- **Scale** the broker pool. Scale-down requires Cruise Control (opt-in at creation), which
  auto-rebalances partitions off removed brokers.
- **Connectivity**: an in-cluster SCRAM listener (port 9092) always; an external LoadBalancer
  listener (port 9094) when `exposeExternalListener` is set.

## Limitations

The operator runs namespace-scoped with Role-only RBAC, so rack awareness and NodePort listeners
are unsupported. Controller replicas, disk sizes and Cruise Control are fixed at creation.
