import { Hono } from "hono";
import PostalMime from "postal-mime";
import { handleQueue } from "./queue";
import { raw } from "hono/html";

type Bindings = {
    EMAIL_STORAGE: R2Bucket;
    DB: D1Database;
    EMAIL_QUEUE: Queue;
};

const app = new Hono<{ Bindings: Bindings }>();

app.post("/webhook/inbound", async (c) => {
    try {
        //  Add authentication mechanism. Webhook provider should give a way to verify requests.
        const payload = await c.req.formData();

        const rawMime = payload.get("message");

        if (rawMime === null || typeof rawMime !== "string") {
            return c.json({ error: "No message field" }, 400);
        }
        const parsed = await PostalMime.parse(rawMime);

        // Use Message-ID for idempotency, fallback to UUID
        // Should we create a hash from its content instead? Ids can contain characters such as < >
        const emailId = parsed.messageId || crypto.randomUUID();
        const timestamp = new Date().toISOString().split("T")[0];
        const storageKey = `emails/${timestamp}/${emailId}.eml`;

        const r2Response = await c.env.EMAIL_STORAGE.put(storageKey, rawMime);
        // Do something with r2Response if needed

        const metadata = {
            from: parsed.from,
            to: parsed.to,
            subject: parsed.subject,
            date: parsed.date,
            attachmentCount: parsed.attachments.length,
            inReplyTo: parsed.inReplyTo,
            references: parsed.references,
        };

        try {
            await c.env.DB.prepare(
                `
                INSERT INTO email_inbox (id, storage_key, status, received_at, metadata)
                VALUES (?, ?, 'pending', datetime('now'), ?)
                  `
            )
                .bind(emailId, storageKey, JSON.stringify(metadata))
                .run();
        } catch (dbError: unknown) {
            if (
                dbError instanceof Error &&
                dbError.message.includes("UNIQUE constraint")
            ) {
                return c.json(
                    {
                        status: "success",
                        emailId,
                        note: "duplicate",
                    },
                    200
                );
            }
            throw dbError;
        }

        await c.env.EMAIL_QUEUE.send({
            emailId,
            storageKey,
        });

        return c.json(
            {
                status: "success",
                emailId,
                storageKey,
            },
            200
        );
    } catch (error) {
        return c.json({ error: "Failed to process email" }, 500);
    }
});

export default {
    fetch: app.fetch,
    queue: handleQueue,
};
