import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import { refreshMailTrackingRules } from './service/mail-tracking-rules';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (env.migration_freeze === 'true' && url.pathname.startsWith('/api/') &&
			(!['GET', 'HEAD'].includes(req.method) || ['/api/oauth', '/api/public', '/api/init'].some(path => url.pathname.startsWith(path))) && url.pathname !== '/api/webhooks') {
			return Response.json({code: 503, message: '邮箱正在合并，请稍后刷新页面再试。'}, {status: 503, headers: {'Retry-After': '60'}});
		}
		if (env.canonical_host && !url.hostname.endsWith('.workers.dev') && url.hostname !== env.canonical_host) {
			if (url.pathname.startsWith('/api/')) {
				return Response.json({code: 409, message: '邮箱入口已合并，请打开 https://' + env.canonical_host + ' 重新登录。'}, {status: 409});
			}
			const target = new URL('https://' + env.canonical_host);
			if (['/static/', '/attachments/'].some(path => url.pathname.startsWith(path))) {
				target.pathname = url.pathname;
			} else {
				target.pathname = '/login';
				const domain = env.domain.find(domain => url.hostname === domain || url.hostname === 'mail.' + domain);
				if (domain) target.searchParams.set('domain', domain);
			}
			return Response.redirect(target.href, 302);
		}

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
		ctx.waitUntil(refreshMailTrackingRules(env))
	},
};
