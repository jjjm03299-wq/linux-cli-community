const fs = require('fs');
const path = require('path');
const logging = require('winston'); // Winston is the standard logging library for Node.js with rotating file support
const DailyRotateFile = require('winston-daily-rotate-file');
const { CONFIG_DIR } = require('./constants');

/**
 * Create and configure the logger.
 * Always logs to file and to console when using PVPN_DEBUG=1.
 */
function getLogger() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const logFile = path.join(CONFIG_DIR, "pvpn-cli.log");

    const customFormat = logging.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `${timestamp} — protonvpn-cli — ${level.toUpperCase()} — ${stack || message} ${metaStr}`;
    });

    const transports = [];

    // Add console handler only when PVPN_DEBUG=1
    if (process.env.PVPN_DEBUG === "1") {
        transports.push(
            new logging.transports.Console({
                level: 'debug',
                format: logging.format.combine(
                    logging.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss,SSS' }),
                    customFormat
                )
            })
        );
    }

    // Add rotating file handler (Starts a new file at 3MB size limit, max 1 backup)
    transports.push(
        new logging.transports.File({
            filename: logFile,
            level: 'debug',
            maxsize: 3145728, // 3 MB
            maxFiles: 1,
            format: logging.format.combine(
                logging.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss,SSS' }),
                customFormat
            )
        })
    );

    const logger = logging.createLogger({
        level: 'debug',
        transports: transports
    });

    return logger;
}

const logger = getLogger();

module.exports = {
    logger,
    getLogger
};
