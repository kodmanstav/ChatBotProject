const MARKER = Symbol.for('event-agent.timestamped-console');

type ConsoleMethod = (...args: unknown[]) => void;

function timestamp(): string {
   const d = new Date();
   const pad = (n: number, w = 2) => String(n).padStart(w, '0');

   const year = d.getFullYear();
   const month = pad(d.getMonth() + 1);
   const day = pad(d.getDate());
   const hours = pad(d.getHours());
   const minutes = pad(d.getMinutes());
   const seconds = pad(d.getSeconds());
   const ms = pad(d.getMilliseconds(), 3);

   const offsetMinutes = -d.getTimezoneOffset();
   const sign = offsetMinutes >= 0 ? '+' : '-';
   const absOffset = Math.abs(offsetMinutes);
   const offsetHours = pad(Math.floor(absOffset / 60));
   const offsetMins = pad(absOffset % 60);

   return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offsetHours}:${offsetMins}`;
}

function patchMethod(
   methodName: 'log' | 'info' | 'warn' | 'error' | 'debug'
): void {
   const original = console[methodName] as ConsoleMethod;
   console[methodName] = ((...args: unknown[]) => {
      original(`[${timestamp()}]`, ...args);
   }) as ConsoleMethod;
}

export function installTimestampedConsole(): void {
   const globalObj = globalThis as Record<PropertyKey, unknown>;
   if (globalObj[MARKER]) return;
   globalObj[MARKER] = true;

   patchMethod('log');
   patchMethod('info');
   patchMethod('warn');
   patchMethod('error');
   patchMethod('debug');
}

installTimestampedConsole();
