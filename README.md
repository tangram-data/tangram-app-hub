# Tangram App Hub

App manifests and bundled integrations published to the Tangram App Hub.

Each app lives in its own directory and contains a `manifests/` PKL project. Some apps also include packaged libraries under `libs/`.

```bash
# Resolve an app's manifest dependencies
cd <app>/manifests && pkl project resolve

# Build a reproducible app archive
python3 scripts/build-app-archive.py <app> <app>.tar.gz
```
