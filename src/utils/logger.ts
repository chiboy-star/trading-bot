import pino from 'pino';
import config from '../config';

const isDev = process.env.NODE_ENV !== 'production';

// Ensure clean UTF-8 encoding for Windows terminal output
if (process.platform === 'win32') {
    try {
        if (process.stdout && typeof (process.stdout as any).setDefaultEncoding === 'function') {
            (process.stdout as any).setDefaultEncoding('utf8');
        }
    } catch {}
}

let transport: any;
if (isDev) {
    try {
        transport = pino.transport({
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'yyyy-mm-dd HH:MM:ss',
                ignore: 'pid,hostname',
                messageFormat: '{msg}',
            },
        });
    } catch {
        // Fallback to default transport if pino-pretty isn't available
        transport = undefined;
    }
}

export const rootLogger = pino(
    {
        level: config.app.logLevel || 'info',
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport
);

export function createLogger(moduleName: string) {
    return rootLogger.child({ module: moduleName });
}

export const logger = createLogger('trading-bot');
export default logger;
