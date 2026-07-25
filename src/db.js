import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5, // cap connections — more than enough for this workload
});

export async function query(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function withTransaction(operation) {
  const client = await pool.connect();
  try {
    return await runTransactionOnClient(client, operation);
  } finally {
    client.release();
  }
}

export async function runTransactionOnClient(client, operation) {
  await client.query("BEGIN");
  try {
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
