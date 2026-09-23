import pino, { type Logger, type LoggerOptions } from 'pino';
import { REDACT_CENSOR, REDACT_PATHS } from './redactors.js';

export interface LoggerConfig {
  level: string;
  pretty: boolean;
  serviceName: string;
  appVersion: string;
  env: string;
}

/**
 * Create the process-wide pino logger. Never persists tokens, secrets,
 * or free-text employee notes to logs (see redactors.ts and ADR-0007 §11).
 */
export function createLogger(cfg: LoggerConfig): Logger {
  const base: LoggerOptions = {
    level: cfg.level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: {
      service: cfg.serviceName,
      env: cfg.env,
      version: cfg.appVersion,
    },
  };

  if (cfg.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}
