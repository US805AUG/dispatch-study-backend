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
APPLE_AUDIENCE=com.samg.Flight-Dispatch-Question-Bank
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
5. Deploy.

## Schema

Apply `schema.sql` to your Postgres database.

