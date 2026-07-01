import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  appleAudience: process.env.APPLE_AUDIENCE,
  tempAdminBootstrapToken: process.env.TEMP_ADMIN_BOOTSTRAP_TOKEN,
};

if (!config.databaseUrl) {
  console.warn("DATABASE_URL is not set.");
}
if (!config.jwtSecret) {
  console.warn("JWT_SECRET is not set.");
}
if (!config.appleAudience) {
  console.warn("APPLE_AUDIENCE is not set.");
}
