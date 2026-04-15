# AINovel

## 全章节操作可观测性验收（含 rewrite / anti-detect）

文档入口：

- `/home/runner/work/AINovel/AINovel/DevDocs/08-测试策略与验收标准.md`（验收流程与测试映射）
- `/home/runner/work/AINovel/AINovel/DevDocs/10-运维部署与可观测性.md`（运维排障与字段对齐）

一键验收命令（提交建议 → runId → 事件流 → 最终状态 → diff）：

```bash
BOOK_ID="demo-book" CHAPTER=3 BASE_URL="http://localhost:4569" bash -lc '
set -euo pipefail
for MODE in rewrite anti-detect; do
  RESP=$(curl -s -X POST "$BASE_URL/api/books/$BOOK_ID/revise/$CHAPTER" \
    -H "Content-Type: application/json" \
    -d "{\"mode\":\"$MODE\",\"brief\":\"验收-$MODE\"}")
  RUN_ID=$(echo "$RESP" | jq -r ".runId")
  echo "$RESP" | jq .
  for _ in $(seq 1 30); do
    STATUS=$(curl -s "$BASE_URL/api/books/$BOOK_ID/chapter-runs/$RUN_ID" | jq -r ".status")
    [ "$STATUS" != "running" ] && break
    sleep 1
  done
  curl -s "$BASE_URL/api/books/$BOOK_ID/chapter-runs/$RUN_ID/events" | jq .
  curl -s "$BASE_URL/api/books/$BOOK_ID/chapter-runs/$RUN_ID" | jq .
  curl -s "$BASE_URL/api/books/$BOOK_ID/chapter-runs/$RUN_ID/diff" | jq "{runId,status,decision,unchangedReason,beforeContent,afterContent,briefTrace}"
done
'
```
