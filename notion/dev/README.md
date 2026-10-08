# Notion connector dev checks

`write-queue.test.ts` covers the page-viewer save queue (ordering, reverts, splits, A→B→A navigation):

```bash
npx -y esbuild notion/dev/write-queue.test.ts --bundle --platform=node --outfile=/tmp/wq.cjs && node /tmp/wq.cjs
```
