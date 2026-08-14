import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.body.password',
      'password',
      'password_hash',
      'token',
    ],
    censor: '[redacted]',
  },
});
