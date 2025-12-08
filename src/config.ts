import dotenv from "dotenv";

dotenv.config();

export const config = {
  PORT: process.env.PORT || "3000",
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
};
