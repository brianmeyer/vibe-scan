import dotenv from "dotenv";

dotenv.config();

export const config = {
  PORT: process.env.PORT || "3000",
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  // vibescale-ignore-next-line HARDCODED_SECRET - Example URL format in comment, not an actual secret
  // Redis URL for Railway (e.g., redis://default:password@host:port)
  REDIS_URL: process.env.REDIS_URL,
  // Monthly token quota per installation (ALPHA: 5M, prod: 100k)
  MONTHLY_TOKEN_QUOTA: Number(process.env.MONTHLY_TOKEN_QUOTA) || 5_000_000,
};
