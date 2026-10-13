# BeWater Mail 部署

基于上游 `maillab/cloud-mail` 的 `ec7a2bb17c950576c38d7308128cac7696fea169`，于 2026-10-12 部署。

三个邮箱分别使用 `mail-worker/wrangler.com.toml`、`wrangler.icu.toml`、`wrangler.asia.toml`。它们各自绑定独立 D1、KV、管理员地址和 JWT Secret，前端使用同一份官方构建。

## 免费 Resend 回调

Resend Free 支持三个域名、一个 Webhook。唯一入口配置为 `https://mail.bewatermail.com/api/webhooks`。COM Worker 验证原始消息的 Svix 签名，按 `data.from` 域名选择 ICU 或 ASIA Service Binding。目标 Worker 再次验证原始签名，然后更新自己的邮件状态。

三个 Worker 必须分别设置 `jwt_secret` 和 `RESEND_WEBHOOK_SECRET` Secrets；后者使用同一个 Resend Webhook signing secret。Secrets 不保存在此仓库。每个域名在 Cloud Mail 的系统设置中使用仅限自己域名的 Resend Sending access key。

事件订阅：`email.bounced`、`email.complained`、`email.delivered`、`email.delivery_delayed`、`email.failed`。未订阅 opened 和 clicked，域名 tracking 也已关闭。

## 构建和部署

```sh
pnpm --dir mail-vue install
pnpm --dir mail-vue run build
cd mail-worker
pnpm install
pnpm exec wrangler login
pnpm exec wrangler deploy --config wrangler.com.toml
pnpm exec wrangler deploy --config wrangler.icu.toml
pnpm exec wrangler deploy --config wrangler.asia.toml
```

本次使用 CLI 部署，没有配置推送自动部署。已建 Worker 的密钥会保留；重建或迁移时需重新添加 Secrets。升级上游前先备份 D1，并保留 `src/api/resend-api.js` 的签名验证与分发逻辑。请勿将密码、JWT、API keys 或 Webhook signing secret 提交到仓库。

## 已验证

三域名真实 Resend 发信、Cloudflare 收信、网页登录、跨域回复、附件收发和下载、未知前缀 Catch-all 收信、真实签名回调跨 Worker 分发，以及拒绝无签名回调。

## 邮件隐私拦截（2026-10-13）

阅读组件使用 DOMPurify、严格的资源允许列表、禁止脚本的 sandbox iframe 和 CSP。收信后异步识别疑似 1×1／隐藏跟踪图，并通过 Worker 预取少量普通远程图片至原有 KV；浏览器只向本站受权限保护的 API 请求缓存二进制，转为 `blob:` 图片显示。没有缓存、代理失败、存储失败或配额耗尽时保持拦截，绝不从网页直连图片来源。用户可在正文上方切换严格模式（所有外部图片都不显示），选择按站点／用户／浏览器本地保存。页面分别显示疑似跟踪图、缓存图、其他拦截图和被清理链接的数量。外部样式、字体、脚本和嵌入继续拦截；安全内嵌栅格图与本站附件保留。回复、转发、草稿和粘贴的 HTML 同样净化，原始邮件数据库不变。已知追踪参数会从普通外链移除，登录／签名类链接保留；外部链接仅在手动点击时打开，不发送 ping 或 Referrer。

预取设定：每站点每天最多 20 封有远程图片的新收邮件、每封最多 4 张普通图片、每张最多 512 KB、缓存 TTL 5 天；图片必须是公开 HTTPS 地址和可识别的安全栅格格式，限制重定向和运行时间。使用现有 KV，无 R2 或新付费资源。服务端从 Cloudflare 出口请求，出口 IP 不固定，发件方仍可能从唯一图片 URL 得知邮件送达／预取时间。收信处理使用 `ctx.waitUntil`，图片失败不会阻断邮件。刚生成的 KV 缓存可能因跨位置一致性延迟稍后才可见。

### 邮件追踪规则（2026-10-13）

三个 Worker 均从 [AdGuard Mail Tracking Protection](https://github.com/AdguardTeam/FiltersRegistry/blob/master/filters/filter_25_Mail_Tracking_Protection/filter.txt) 读取专用免费规则；当前版本解析 506 条拦截规则和 1 条例外。列表按 [GPL-3.0](https://github.com/AdguardTeam/AdGuardFilters/blob/master/LICENSE) 提供，运行时作为数据从官方仓库获取，不复制进本仓库。每个 Worker 在现有每小时维护任务中检查更新时间，约每 24 小时更新一次，验证来源、大小和规则数后存入已有 KV；下载失败保留上一次规则，内置的小图和追踪 URL 判断也继续生效。列表读取失败、图片缓存失败时仍只拦截，不从网页直连。规则更新对旧邮件和旧缓存也生效：读取清单时重新分类，新增命中的缓存图不再提供给前端；旧邮件不会因为重新分类而请求发件方。

实际检查了两封用户已有的 Claude 官方邮件：验证邮件中的 `mail.anthropic.com/wf/open?upn=…` 1×1 像素被识别，而 `claude.ai` 的正常 Logo/社交图片没有误判为同一规则。三个生产站点另外各自用真实收信验证了“仅专用列表命中”的测试图片被拦截、普通 PNG 被缓存。维护代码为 `mail-worker/src/service/mail-tracking-rules.js`，测试运行 `cd mail-worker && node --test test/mail-privacy.test.mjs test/mail-tracking-rules.test.mjs`。启发式及公开规则无法保证识别所有未来追踪器；未识别普通图片依旧只在收信时预取，不会暴露打开时间。

浏览器回归测试：分别运行 `node mail-vue/test/privacy-trap.mjs` 和 `pnpm --dir mail-vue exec vite --host 127.0.0.1 --port 3217`，在 Chrome 打开 `http://127.0.0.1:3217/test/privacy-browser.html`。页面 29 项检查阅读组件、缓存图片、严格模式、TinyMCE、净化策略及 CSP；收集器 `/hits` 只应包含控制请求 `/control`，不应收到邮件跟踪资源请求。后端运行 `cd mail-worker && node --test test/mail-privacy.test.mjs`，覆盖跟踪器分类、私有目的地／重定向拒绝、大小和类型限制、失败后拦截。三个生产站点均已验证真实邮件、缓存清单与授权图片读取。合并上游时保留 `mail-vue/src/utils/mail-privacy.js`、`mail-worker/src/service/mail-privacy-service.js` 与阅读／编辑组件的保护逻辑。

这是网页邮箱部署，未提供 IMAP、POP3 或 SMTP 客户端接口。免费额度在账户层共享；Resend 每天 100 封、每月 3,000 封，Cloudflare 也有请求和存储配额。
