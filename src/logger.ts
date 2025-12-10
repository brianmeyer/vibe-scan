/**
 * Simple structured logger for production.
 * Outputs JSON logs for easy parsing by Railway/cloud providers.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function formatLog(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  if (IS_PRODUCTION) {
    // JSON format for production (Railway, etc.)
    return JSON.stringify(entry);
  } else {
    // Human-readable format for development
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return `[${entry.timestamp}] ${level.toUpperCase()} ${message}${metaStr}`;
  }
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (!IS_PRODUCTION) {
      console.debug(formatLog("debug", message, meta));
    }
  },

  info(message: string, meta?: Record<string, unknown>): void {
    console.log(formatLog("info", message, meta));
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(formatLog("warn", message, meta));
  },

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(formatLog("error", message, meta));
  },
};
