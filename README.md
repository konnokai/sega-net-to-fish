# SEGA NET 成績 → 水魚查分器

把 SEGA 國際版成績站台（目前是 `maimaidx-eng.com`）的歌曲成績匯入水魚查分器。跑在 Cloudflare Workers 上。CHUNITHM-NET 之後再接。

本專案不是 SEGA 官方工具。

## 怎麼運作

1. 在網站上按「使用水魚帳號登入」。流程是授權碼 + PKCE，`client_secret` 只放在 Worker。登入後網頁才會產生上傳碼。
2. 到 `maimaidx-eng.com` 點書籤。書籤讀五個難度的成績頁，把歌曲資料送到 Worker。
3. Worker 拿水魚的歌曲資料比對，把可匯入的成績存進 Durable Object。
4. 你按「匯入水魚」，Worker 用你的 access token 呼叫 `/player/update_records`。

國際服的登入 cookie 只留在你的瀏覽器，Worker 只收到歌曲成績。

水魚的 refresh token 存在 Durable Object。每次刷新都會換一組新的；同一個 DO 會排隊處理，避免同時刷新把整串 token 弄壞。

## 目前限制

- CHUNITHM 先不做。
- 水魚的寫入權限要人工審核。還沒通過時，`prober.records.write` 的授權頁會拒絕，匯入一定失敗。
- 所有狀態放在同一個 Durable Object。這是給小工具用的簡化，流量大再拆。

## 本機開發

需求：Node 20 以上。本機 `wrangler dev` 不需要 Cloudflare 登入。

1. 到 <https://auth.diving-fish.com/console> 登記應用：
   - 部署形態：由你自己部署運行（機密客戶端）
   - 回調地址：`http://127.0.0.1:8787/callback`
   - 權限：`prober.records.write`
   - 登記完再產生 `client_secret`
2. `npm install`
3. 複製 `.dev.vars.example` 成 `.dev.vars`，填入：
   - `DF_CLIENT_SECRET`：控制台產生的 secret
   - `SESSION_SECRET`：用 `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` 產生的隨機字串
4. 把 `wrangler.jsonc` 裡的 `DF_CLIENT_ID` 換成你的 client_id。
5. `npm run dev`，開 <http://127.0.0.1:8787/>。
6. 第一次在 `maimaidx-eng.com` 點書籤時，Chrome 會問「存取本機網路」，要按允許。

只想測登入流程時，可以在 `.dev.vars` 加 `DF_SCOPE=profile`。這只能測登入，不能匯入成績。

本機的 Durable Object 狀態存在 `.wrangler/state`。要清掉登入狀態，停掉 dev 後刪掉這個資料夾。

## 部署到 Cloudflare Workers

這個 repo 跟 Cloudflare Workers Builds 綁定：**push 到 `main` 就會自動部署**，不用手動下指令。不要用 push 當預覽。

環境設定（只做一次）：

1. 在 Cloudflare dashboard 把 Worker 接到 GitHub repo。用別人的 fork 要自己接一次。
2. 設定 secrets，用 dashboard（Settings → Variables and Secrets）或本機：

   ```
   npx wrangler secret put DF_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   ```

3. 把 `/callback` 填到水魚控制台。目前是
   `https://net-to-df.konnokai.me/callback`；用 workers.dev 的話是
   `https://<worker>.<subdomain>.workers.dev/callback`。

第一次部署會自動建立 Durable Object（migration `v1`）。

手動部署只在自動部署壞掉或臨時測試時用：`npx wrangler login`，再 `npm run deploy`。

用同一個網址開網站。redirect URI 是從 request 的 origin 組出來的，所以網址要跟控制台登記的完全一致。

免費方案可以跑：這個專案用 `new_sqlite_classes`，免費方案的 Durable Object 只支援 SQLite 後端。免費方案的 duration 上限是每天 13,000 GB-s，一條開整天不關的 SSE 連線大約吃掉 10,800 GB-s（128 MB × 86,400 秒）。頁面用完就關，或改用付費方案。

## 常用指令

- `npm run dev`：本機 Worker + 本機 Durable Object
- `npm test`：測 `lib/core.mjs` 的歌曲比對與成績轉換
- `npm run deploy`：手動部署。平常 push 到 `main` 就會自動部署。

## 資料放哪裡

- 瀏覽器：`df_session`（簽章過的 session id）、`df_login`（PKCE 的 state / verifier，10 分鐘）。
- Durable Object：session（含 refresh token）、上傳碼（15 分鐘）、最近一次上傳（1 小時）。
- Worker 記憶體：`music_data` 快取 1 小時，每個 isolate 各自一份。
- 沒有用 D1、KV、R2。

## 頁面怎麼更新

頁面只打一次 `/api/state`，之後靠 `/api/events` 的 SSE 連線收推播。書籤送成績進來時，Durable Object 直接寫進已開著的連線，不會輪詢。

SSE 連線開著期間，Durable Object 會一直被算作活躍（大約每 20 秒送一次心跳）。關掉頁面後連線結束，心跳最多再跑一輪就停，物件回到一般閒置狀態。同時最多 200 條連線，滿了回 503。

推播的畫面內容和 `/api/state` 一樣。「查無歌曲」清單只送前 200 筆，總數照實顯示。

## 已知行為

- 同名的 `Link` 與 `Link(CoF)` 用 DX 分數上限分辨。
- 國際服限定曲、水魚沒有的歌會列在「查無歌曲」，匯入時跳過。
- 國際服的成績頁一次就包含該難度全部歌曲，不用翻頁。
