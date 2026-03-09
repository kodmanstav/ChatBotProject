const PREFIX = '[EventAgent]';

export function logInfo(message: string, ...args: unknown[]): void {
   console.log(`${PREFIX} ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
   console.error(`${PREFIX} ${message}`, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
   console.warn(`${PREFIX} ${message}`, ...args);
}
