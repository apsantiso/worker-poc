import { Hono } from 'hono';
import PostalMime from 'postal-mime';

type Bindings = {
  EMAIL_STORAGE: R2Bucket;
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.post('/webhook/inbound', async (c) => {
  try {
    // TODO: Add authentication mechanism
    const payload = await c.req.formData();
    const rawMime = payload.get('message');

    if (rawMime === null || typeof rawMime !== 'string') {
      return c.json({ error: 'No message field' }, 400);
    }

    // If we want to get real idempotency, we can parse the email and get Message-ID header.
    // It adds more processing time though.
    // Example:
    // const parsedEmail = PostalMime.parse(rawMime);
    // const messageId = parsedEmail.headers['message-id'];
    const emailId = crypto.randomUUID();
    const timestamp = new Date().toISOString().split('T')[0];
    const storageKey = `emails/${timestamp}/${emailId}.eml`;

    await c.env.EMAIL_STORAGE.put(
      storageKey,
      rawMime,
    );

    try {
      // Outbox pattern so we do not rely on a queue system
      await c.env.DB.prepare(`
        INSERT INTO email_inbox (id, storage_key, status, received_at)
        VALUES (?, ?, 'pending', datetime('now'))
      `).bind(emailId, storageKey).run();

    } catch (dbError: unknown) {
      if (dbError instanceof Error && dbError.message.includes('UNIQUE constraint')) {
        return c.json({
          status: 'success',
          emailId,
          note: 'duplicate'
        }, 200);
      }
      throw dbError;
    }

    return c.json({
      status: 'success',
      emailId,
      storageKey
    }, 200);

  } catch (error) {
    console.error('Error:', error);
    return c.json({ error: 'Failed to store email' }, 500);
  }
});

export default app;