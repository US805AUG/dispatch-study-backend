import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  appleAudience: process.env.APPLE_AUDIENCE,
  tempAdminBootstrapToken: process.env.TEMP_ADMIN_BOOTSTRAP_TOKEN,
  analyticsInternalInstallIds: process.env.ANALYTICS_INTERNAL_INSTALL_IDS ?? "",
  analyticsInternalUserIds: process.env.ANALYTICS_INTERNAL_USER_IDS ?? "",
  geoIpEnabled: String(process.env.GEOIP_ENABLED ?? "false").toLowerCase() === "true",
  geoIpProvider: String(process.env.GEOIP_PROVIDER ?? "disabled").toLowerCase(),
  geoIpApiKey: process.env.GEOIP_API_KEY,
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
