const QUEUE_NAMES = {
    EMAIL_PROCESS: "email-process-queue",
} as const;

const DRIVE_CONFIG = {
    API_URL: "http://localhost:6382",
    BUCKET_ID: "692d68c06a72483f7b12edd3",
    AUTH_TOKEN:
        "Basic bGVjYXRpMTQwNUBkb2NzZnkuY29tOmQyODc2NmEzNzQ5MzhlNTA5ZDI5YzM3NjQzMzY1NGVjMzZhNzgzODE2OTgzZmRlZmQ5OTA0ZDA5NjQ1MmEzMzc=",
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

type DriveUploadResponse = {
    uploads: Array<{
        index: number;
        uuid: string;
        url: string;
        urls: string[] | null;
    }>;
};

type SignedURLData = {
    url: string;
    uuid: string;
};

async function getSignedURL(fileSize: number): Promise<SignedURLData> {
    const url = `${DRIVE_CONFIG.API_URL}/v2/buckets/${DRIVE_CONFIG.BUCKET_ID}/files/start?multiparts=1`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "internxt-version": "1.0",
            "internxt-client": "drive-web",
            Authorization: DRIVE_CONFIG.AUTH_TOKEN,
        },
        body: JSON.stringify({
            uploads: [
                {
                    index: 0,
                    size: fileSize,
                },
            ],
        }),
    });

    if (!response.ok) {
        throw new Error(
            `Failed to get signed URL: ${response.status} ${response.statusText}`
        );
    }

    const data = (await response.json()) as DriveUploadResponse;

    if (!data.uploads || data.uploads.length === 0) {
        throw new Error("No uploads in response");
    }

    return {
        url: data.uploads[0].url,
        uuid: data.uploads[0].uuid,
    };
}

// Probably not the same function as drive-web but just for the POC
async function calculateSHA256(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function finishUpload(
    index: string,
    hash: string,
    uuid: string
): Promise<void> {
    const url = `${DRIVE_CONFIG.API_URL}/v2/buckets/${DRIVE_CONFIG.BUCKET_ID}/files/finish`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "internxt-version": "1.0",
            "internxt-client": "drive-web",
            Authorization: DRIVE_CONFIG.AUTH_TOKEN,
        },
        body: JSON.stringify({
            index: index,
            shards: [
                {
                    hash: hash,
                    uuid: uuid,
                },
            ],
        }),
    });

    if (!response.ok) {
        throw new Error(
            `Failed to finish upload: ${response.status} ${response.statusText}`
        );
    }
    return response.json();
}

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

        const fileContent = await r2Object.arrayBuffer();
        const fileHash = await calculateSHA256(fileContent);

        // Get signed URL from Drive API
        const fileSize = fileContent.byteLength;
        const { url: signedURL, uuid } = await getSignedURL(fileSize);

        // Upload to S3 from memory
        const response = await fetch(signedURL, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
            },
            body: fileContent,
        });

        if (!response.ok) {
            throw new Error(
                `Failed to upload to S3: ${response.status} ${response.statusText}`
            );
        }

        // Notify Drive about completed upload
        const uploadResult = await finishUpload(fileHash, fileHash, uuid);
        console.log("Finish upload result:", uploadResult);

        // TODO: Request to drive gateway to store metadata
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
