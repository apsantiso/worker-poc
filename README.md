# Email Processing Worker - POC

A Cloudflare Worker that receives inbound emails, stores them in R2, and processes them asynchronously using Queues and D1.

## How it works?
1. Producer receives the email and parses all the required metadata from the raw email. This is just a worker exposed to the internet, so cloudflare can scale it when required.
2. The entire raw mail is stored in R2 by the producer.
3. Producer saves the email metadata and internal data (status, emailId, storageKey).
4. Producer sends storageKey and emailId to a queue
5. A consumer receives the event
6. Consumer looks for the email data in D1 by the emailID
7. Consumer donwloads the email from R2
8. Consumer calculates the hash from the content of the raw email.
9. Consumer asks drive for a signed URL
10. Consumer uploads email content to the signed URL
11. Consumer notifies drive about the file upload finished
12. Consumer makes a request to email API
13. Consumer marks the email as 'processed'


## Architecture

**Flow**: `Incoming Email → Webhook → R2 + D1 → Queue → Process → External Drive (TODO)`

- **Webhook** (`/webhook/inbound`): Receives emails, parses with `postal-mime`, stores in R2, saves metadata to D1
- **R2 Storage**: Temporary storage for raw email files (`emails/{date}/{id}.eml`)
- **D1 Database**: Tracks status and metadata (from, to, subject, etc.)
- **Queue**: Async processing with retries and dead letter queue
- **Consumer** (`src/queue.ts`): Fetches email from R2, ready to send to external storage. This scales horizontally https://developers.cloudflare.com/queues/configuration/consumer-concurrency/

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create resources
```bash
# Create R2 bucket
npx wrangler r2 bucket create email-storage

# Create D1 database (save the database_id from output)
npx wrangler d1 create email-inbox

# Create queues
npx wrangler queues create email-process-queue
npx wrangler queues create email-dlq
```

### 3. Configure wrangler.jsonc
Update `database_id` in `wrangler.jsonc` with the ID from step 2.

### 4. Apply migrations
```bash
npx wrangler d1 migrations apply email-inbox
```

### 5. Modify DRIVE_CONFIG in queue.ts
- API_URL: drive's bridge URL
- BUCKET_ID: User's bucket ID in Drive
- AUTH_TOKEN: The value we use as header when retrieving files from drive.


### 6. Run locally
```bash
npx wrangler dev
```

## Database Schema

`email_inbox` table:
- `id` - Message ID or UUID
- `storage_key` - R2 path
- `status` - pending/processing/completed/failed
- `received_at` - Timestamp
- `processed_at` - Timestamp
- `metadata` - JSON (from, to, subject, date, attachments)

## TODO

- Add authentication (according to the third party email provider)
- Integrate with Internxt mail's API
- We need to get the user credentials from somewhere to be able to ask for a drive signed URL.

## Fallbacks
- What should we do when any of the external request fails in the consumer? Should we make sure they are idempotent? We should not add duplicated emails if one of them fails.
- How are we going to monitor DLQ? Should we add a consumer to the DLQ or search for a notification system to monitor this?
- How are we going to notify the senders if the target mail does not exist? There are some email servers (or providers) that returns a response according to the webhook, but if we choose any external provider that does not check the webhook before accepting the email, we should not be able to notify senders about email size (unless the server rejects it directly) or not existent mails.

