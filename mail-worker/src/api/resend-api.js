import resendService from '../service/resend-service';
import app from '../hono/hono';
import { Resend } from 'resend';
app.post('/webhooks',async (c) => {
	const payload = await c.req.text();
	let event;
	try {
		if (!c.env.RESEND_WEBHOOK_SECRET) return c.text('Webhook not configured', 503);
		event = new Resend('verification-only').webhooks.verify({
			payload,
			webhookSecret: c.env.RESEND_WEBHOOK_SECRET,
			headers: {
				id: c.req.header('svix-id'),
				timestamp: c.req.header('svix-timestamp'),
				signature: c.req.header('svix-signature')
			}
		});
	} catch {
		return c.text('Invalid webhook signature', 401);
	}

	// Resend Free permits one endpoint. Route signed events to the isolated mailbox.
	const from = typeof event.data?.from === 'string' ? event.data.from : '';
	const domain = from.match(/@([^\s<>]+)>?\s*$/)?.[1]?.toLowerCase();
	const destinations = {
		'bewatermail.icu': c.env.webhook_icu,
		'bewatermail.asia': c.env.webhook_asia
	};
	if (c.env.unified_mode !== 'true' && destinations[domain]) {
		return destinations[domain].fetch(`https://mail.${domain}/api/webhooks`, {
			method: 'POST', headers: c.req.raw.headers, body: payload
		});
	}
	if (!c.env.domain.includes(domain)) return c.text('Ignored domain', 200);
	if (!['email.bounced', 'email.complained', 'email.delivered', 'email.delivery_delayed', 'email.failed'].includes(event.type)) {
		return c.text('Ignored event', 200);
	}
	try {
		await resendService.webhooks(c, event);
		return c.text('success', 200)
	} catch (e) {
		return  c.text(e.message, 500)
	}
})
