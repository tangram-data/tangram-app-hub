# Kafka Operator

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
- **Tangram-native access (port 9095)**: clients authenticate with their own Tangram auth token
  over SASL/OAUTHBEARER — no Kafka credentials needed — and topic reads/writes are authorized by
  Tangram IAM (`Topic#Read` / `Topic#Write` grants on the topic resources). Brokers introspect
  tokens against the app service and enforce decisions through a custom authorizer baked into the
  broker image; sessions re-authenticate periodically so revoked/expired tokens age out.

  Client config (the token is a Biscuit, not a JWT — both `oauth.access.token.is.jwt=false` and the
  strimzi client login callback are required):

  ```properties
  security.protocol=SASL_PLAINTEXT
  sasl.mechanism=OAUTHBEARER
  sasl.login.callback.handler.class=io.strimzi.kafka.oauth.client.JaasClientOauthLoginCallbackHandler
  sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required \
    oauth.access.token="<TANGRAM_TOKEN>" oauth.access.token.is.jwt="false" ;
  ```

## Limitations

The operator runs namespace-scoped with Role-only RBAC, so rack awareness and NodePort listeners
are unsupported. Controller replicas, disk sizes and Cruise Control are fixed at creation.

## Browser event ingestion (Mixpanel-style)

The app serves a public ingest endpoint authenticated ONLY by a write-only ingestion key
(create one via the Topic `CreateIngestionKey` action). The manifest declares the `ingest`
public endpoint, so the platform exposes exactly this subtree at
`https://public.<domain>/<workspace>/ai.tangram/kafka-operator/ingest/...` with managed TLS —
browser traffic must NOT go through the platform gateway (it requires platform tokens and is
the control plane).

    POST /api/v1/ingest/{cluster}/{topic}
      Authorization: Bearer <key>   (or X-Ingest-Key: <key>, or ?key=<key> for sendBeacon)
      body: {"events": [...]} | [...] | single JSON object   (application/json or text/plain)

A string `distinct_id` in an event becomes the Kafka partition key. Per-key rate limit:
2000 events/s. Origin scoping (server-side; CORS itself stays allow-all): a key created with
`allowedOrigins` only accepts requests whose `Origin` header matches, and the app setting
`ingestAllowedOrigins` provides the workspace-wide default when a key has no list of its own.
Minimal JS client:

```js
// The platform-managed public endpoint: /<workspace>/<group>/<app>/<endpointName> + the
// declared pathPrefix's remainder (pathPrefix /api/v1/ingest is stripped down to /ingest/...).
const INGEST = "https://public.example.tangram-os.com/demo/ai.tangram/kafka-operator/ingest/kafka/web-events";
const KEY = "wek_...";
const queue = [];
export function track(event, props = {}) {
  queue.push({ event, distinct_id: getUserId(), time: Date.now(), ...props });
  if (queue.length >= 20) flush();
}
function flush() {
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue.splice(0) });
  fetch(`${INGEST}?key=${KEY}`, { method: "POST", body, keepalive: true });
}
setInterval(flush, 5000);
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && queue.length)
    navigator.sendBeacon(`${INGEST}?key=${KEY}`, JSON.stringify({ events: queue.splice(0) }));
});
```
