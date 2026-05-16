export const deploymentInfo = {
  commitSha:
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    "unknown",
  deploymentTimestamp: new Date().toISOString(),
  environment:
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.NODE_ENV ||
    "unknown",
};
