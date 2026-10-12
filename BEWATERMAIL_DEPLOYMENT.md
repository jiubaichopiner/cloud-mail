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

这是网页邮箱部署，未提供 IMAP、POP3 或 SMTP 客户端接口。免费额度在账户层共享；Resend 每天 100 封、每月 3,000 封，Cloudflare 也有请求和存储配额。
