# Dispatch Study Backend (Railway)

This service provides:
- Sign in with Apple verification
- Role-based auth (owner/mod/user)
- Content distribution endpoints for study items

## Environment

Create a `.env` file with:

```
PORT=8080
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DB
JWT_SECRET=replace_me_with_a_long_random_string
APPLE_AUDIENCE=com.samg.Flight-Dispatch-Question-Bank,com.samg.study-ops
# Optional: HTTPS endpoint that receives metadata-only feedback notifications.
# The feedback message body is never sent to this webhook.
FEEDBACK_NOTIFICATION_WEBHOOK_URL=https://your-approved-owner-notifier.example/feedback
```

## Local dev

```
npm install
npm run dev
```

## Railway

1. Create a new GitHub repo from this folder.
2. Connect the repo in Railway.
3. Add a Postgres plugin and set `DATABASE_URL`.
4. Add `JWT_SECRET` and `APPLE_AUDIENCE`.
5. Optionally add `FEEDBACK_NOTIFICATION_WEBHOOK_URL` only after approving the destination. It receives feedback ID, category, timestamp, app/build/platform, and question ID, but never the message body or credentials.
6. Deploy.

The owner/admin-only `GET /api/admin/feedback?limit=25&before=<ISO-8601>` endpoint powers the Feedback Inbox in `Sadiom-Work/admin/flight-dispatch-analytics.html`. It requires a normal backend JWT and returns newest-first safe fields. If the webhook is unset or unavailable, feedback is still saved and remains visible in the inbox.

## Schema

Apply `schema.sql` to your Postgres database.
