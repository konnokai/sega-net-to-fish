# AGENTS.md

單一 Cloudflare Worker，把 `maimaidx-eng.com` 的成績匯入水魚查分器。沒有框架、沒有 build step，`wrangler` 直接跑 ESM。

## 指令

- `npm run dev`：本機 Worker + 本機 Durable Object，開 <http://127.0.0.1:8787/>。不需要 Cloudflare 登入。
- `npm test`：跑 `node --test test/`。只測 `lib/core.mjs`。
- 單一測試：`node --test --test-name-pattern "Link" test/core.test.mjs`
- 沒有 lint、typecheck、formatter。改完至少跑 `node --check src/worker.js` 和 `node --check public/app.js`。
- `npx wrangler deploy --dry-run`：確認 bundle 沒壞，不會真的部署。
- 只想測登入流程：`.dev.vars` 加 `DF_SCOPE=profile`，但這樣不能匯入成績。

## 部署

- **push 到 `main` 就會自動部署**（Cloudflare Workers Builds 綁 GitHub）。不要把 push 當預覽用。
- 手動 `npm run deploy` 只在臨時狀況使用。
- 正式網域 `https://net-to-df.konnokai.me` 在 Cloudflare dashboard 綁定，不在 `wrangler.jsonc`。
- `DF_CLIENT_SECRET`、`SESSION_SECRET` 只在 `.dev.vars` 和 dashboard secrets；`DF_CLIENT_ID` 在 `wrangler.jsonc`。

## 結構

- `src/worker.js`：全部路由（`route()`）+ `AppState` Durable Object。DO 只有一個實例（`idFromName('main')`）。
- `public/`：靜態檔走 `ASSETS` binding；沒匹配的路徑最後才 `env.ASSETS.fetch()`。新增檔案不用改路由。
- `public/bm.js`：注入 `maimaidx-eng.com` 抓成績的書籤腳本。
- `lib/core.mjs`：純函式（歌名比對、fc/fs 轉換），worker 和測試共用。新的比對邏輯放這裡才測得到。
- 測試檔放 `test/*.test.mjs`；`npm test` 只掃 `test/`。
- `wrangler.jsonc`：DO migration `v1` 用 `new_sqlite_classes`（免費方案必需）。改 DO class 名稱要新增 migration tag，不能改舊的。

## 容易踩到

- 沒有 `.dev.vars` 也能 `npm run dev`，但 `/api/state` 會回 `clientConfigured:false`，`/api/upload-code`、`/api/import`、`/api/events` 都 503，`/api/login` 跳 `?auth=config`。看到 503 先確認檔案在不在。
- 儲存只有三種：瀏覽器 cookie、Durable Object、Worker isolate 的記憶體快取（歌曲索引 1 小時）。沒有 D1、KV、R2。
- 登入後跳 `?auth=scope`，或匯入被水魚拒絕，可能是 `prober.records.write` 的人工審核還沒過，不是程式錯。另一個可能是控制台沒開 `openid profile`（只用來讀使用者名稱）。水魚收到沒申請的 scope 是直接拒絕還是默默略過，還沒實測。
- 所有 session、上傳碼、上傳結果都在同一個 DO。refresh token 輪替靠 DO 序列化，不要把換票搬出 DO。
- DO 改狀態後要 `#broadcast(sessionId)`；前端只有 `/api/events` 的 SSE，沒有輪詢。漏推畫面就不會更新。
- 上傳碼要登入後才產生。前端用 `/api/state` 的 `hasSession` 判斷，不要改回載入就自動打 `/api/upload-code`。
- `allowedOrigins()` 只保護 `/api/ingest` 的 CORS。Origin 可以偽造，不是安全機制。
- `/callback` 的 redirect URI 由 request origin 組出來。水魚控制台只有一個 callback 欄位，切本機／正式站要手動改。
- 本機 DO 資料在 `.wrangler/state/v3/do/sega-net-to-fish-AppState/`；dev 跑著時 sqlite 被鎖住，要讀就開唯讀連線。清登入狀態＝停 dev 後刪 `.wrangler/state`。
- SSE 連著時 DO 一直算活躍。免費方案 13,000 GB-s/天，一條整天開著的連線約 10,800 GB-s。
- `npm test` 不碰 Worker 和 DO。改路由、DO 或畫面流程要自己 `npm run dev` 走一次。
