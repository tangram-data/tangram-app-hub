# Hub component checks

`notion-write-queue.test.ts` covers the Notion page-viewer save queue (ordering, reverts, splits, A→B→A navigation):

```bash
npx -y esbuild tests/notion-write-queue.test.ts --bundle --platform=node --outfile=/tmp/wq.cjs && node /tmp/wq.cjs
```
