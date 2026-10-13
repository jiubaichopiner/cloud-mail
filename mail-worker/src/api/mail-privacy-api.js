import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import emailService from '../service/email-service';
import { getMailImageManifest, getMailImage } from '../service/mail-privacy-service';

app.get('/email/privacy/manifest', async c => {
  const emailId = Number(c.req.query('emailId'));
  const manifest = await getMailImageManifest(c, emailId, userContext.getUserId(c), emailService);
  if (!manifest) return c.json(result.fail('Message not found', 404), 404);
  return c.json(result.ok(manifest));
});

app.post('/email/privacy/image', async c => {
  const body = await c.req.json();
  const image = await getMailImage(c, Number(body.emailId), body.hash, userContext.getUserId(c), emailService);
  if (!image) return c.text('Image unavailable', 404);
  return image;
});
