import { appendFile } from 'fs';
import { resolve } from 'path';

const PREFIX = '[EventAgent]';

// Single shared execution log for all components
const EXECUTION_LOG_PATH =
   process.env.EXECUTION_LOG_PATH ||
   resolve(__dirname, '..', '..', 'execution-log.txt');

export function logInfo(message: string, ...args: unknown[]): void {
   console.log(`${PREFIX} ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
   console.error(`${PREFIX} ${message}`, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
   console.warn(`${PREFIX} ${message}`, ...args);
}

export function logExecution(
   component: string,
   conversationId: string | null,
   event: string,
   details?: Record<string, unknown>
): void {
   const ts = new Date().toISOString();
   const cid = conversationId ?? '-';
   const base = `${ts} | ${component} | conv=${cid} | ${event}`;
   const extra =
      details && Object.keys(details).length
         ? ` | ${JSON.stringify(details)}`
         : '';
   const line = `${base}${extra}\n`;

   appendFile(EXECUTION_LOG_PATH, line, (err) => {
      if (err) {
         // Fall back to console only; avoid throwing inside logger
         console.error(
            `${PREFIX} Failed to write to execution log:`,
            err.message ?? err
         );
      }
   });
}
