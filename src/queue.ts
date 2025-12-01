const QUEUE_NAMES = {
    EMAIL_PROCESS: "email-process-queue",
} as const;

type Bindings = {
    EMAIL_STORAGE: R2Bucket;
    DB: D1Database;
    EMAIL_QUEUE: Queue;
};

type EmailQueueMessage = {
    emailId: string;
    storageKey: string;
};

async function processEmail(
    message: Message<EmailQueueMessage>,
    env: Bindings
): Promise<void> {
    try {
        const { emailId } = message.body;

        const result = await env.DB.prepare(
            `SELECT metadata, storage_key FROM email_inbox WHERE id = ?`
        )
            .bind(emailId)
            .first();

        if (!result) {
            throw new Error("Email not found in database");
        }

        const metadata = JSON.parse(result.metadata as string);

        // Get the email stream from R2
        const storageKey = result.storage_key as string;
        const r2Object = await env.EMAIL_STORAGE.get(storageKey);

        if (!r2Object) {
            throw new Error(`Email not found in R2 storage: ${storageKey}`);
        }

        // TODO: Get signed URL from drive.
        // await getSignedURL(storageKey, DRIVE_URL, r2Object);

        // TODO: Stream email to Drive using the signed URL
        // await streamToDrive(signedURL, r2Object);

        // TODO: Send Drive upload finished
        // await finishUploadRequest(storageKey, DRIVE_URL);

        // TODO: Request to drive gateway to store metadata with email stream
        // await storeInExternalDB(emailId, metadata);

        await env.DB.prepare(
            `
          UPDATE email_inbox
          SET status = 'completed', processed_at = datetime('now')
          WHERE id = ?
      `
        )
            .bind(emailId)
            .run();

        // TODO: Clean up transitory storage (R2). We can even keep it for a while for recovery.
        // await env.EMAIL_STORAGE.delete(storageKey);

        message.ack();
    } catch (error) {
        console.error("Failed to process:", error);
        message.retry();
    }
}

export async function handleQueue(
    batch: MessageBatch<EmailQueueMessage>,
    env: Bindings
): Promise<void> {
    if (batch.queue === QUEUE_NAMES.EMAIL_PROCESS) {
        for (const message of batch.messages) {
            await processEmail(message, env);
        }
    }
}
