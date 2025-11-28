/**
 * Simple structured logger with configurable log levels.
 * 
 * Log Levels (in order of verbosity):
 * - ERROR: Critical errors that need attention
 * - WARN:  Warning conditions
 * - INFO:  Key operational events (default for production)
 * - DEBUG: Detailed debugging information
 * 
 * Configure via LOG_LEVEL environment variable.
 * Default: "info" in production, "debug" in development
 */

type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getConfiguredLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel;
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel;
  }
  // Default: info in production, debug in development
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = getConfiguredLevel();
  return LOG_LEVELS[level] <= LOG_LEVELS[configuredLevel];
}

function formatMessage(component: string, message: string): string {
  return `[${component}] ${message}`;
}

export const logger = {
  error(component: string, message: string, error?: unknown): void {
    if (shouldLog("error")) {
      const formatted = formatMessage(component, message);
      if (error) {
        console.error(formatted, error);
      } else {
        console.error(formatted);
      }
    }
  },

  warn(component: string, message: string, data?: unknown): void {
    if (shouldLog("warn")) {
      const formatted = formatMessage(component, message);
      if (data !== undefined) {
        console.warn(formatted, data);
      } else {
        console.warn(formatted);
      }
    }
  },

  info(component: string, message: string, data?: unknown): void {
    if (shouldLog("info")) {
      const formatted = formatMessage(component, message);
      if (data !== undefined) {
        console.log(formatted, data);
      } else {
        console.log(formatted);
      }
    }
  },

  debug(component: string, message: string, data?: unknown): void {
    if (shouldLog("debug")) {
      const formatted = formatMessage(component, message);
      if (data !== undefined) {
        console.log(formatted, data);
      } else {
        console.log(formatted);
      }
    }
  },
};

// Component-specific loggers for common use cases
export const paginationLog = {
  debug: (msg: string, data?: unknown) => logger.debug("Pagination", msg, data),
  info: (msg: string, data?: unknown) => logger.info("Pagination", msg, data),
};

export const sessionLog = {
  debug: (msg: string, data?: unknown) => logger.debug("Session", msg, data),
  info: (msg: string, data?: unknown) => logger.info("Session", msg, data),
  warn: (msg: string, data?: unknown) => logger.warn("Session", msg, data),
};

export const poolLog = {
  debug: (msg: string, data?: unknown) => logger.debug("Pool", msg, data),
  info: (msg: string, data?: unknown) => logger.info("Pool", msg, data),
  error: (msg: string, error?: unknown) => logger.error("Pool", msg, error),
};

