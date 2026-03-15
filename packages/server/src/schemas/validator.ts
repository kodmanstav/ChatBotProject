import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';

const SCHEMA_NAMES = [
   'UserQueryReceived',
   'SynthesizeFinalAnswerRequested',
   'PlanGenerated',
   'ToolInvocationResulted',
   'ToolInvocationRequested',
   'PlanStepCompleted',
   'PlanCompleted',
   'PlanFailed',
   'FinalAnswerSynthesized',
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

const EVENT_TYPE_TO_SCHEMA: Record<string, { dir: string; name: SchemaName }> =
   {
      UserQueryReceived: { dir: 'user-commands', name: 'UserQueryReceived' },
      SynthesizeFinalAnswerRequested: {
         dir: 'user-commands',
         name: 'SynthesizeFinalAnswerRequested',
      },
      PlanGenerated: { dir: 'conversation-events', name: 'PlanGenerated' },
      ToolInvocationResulted: {
         dir: 'conversation-events',
         name: 'ToolInvocationResulted',
      },
      ToolInvocationRequested: {
         dir: 'tool-invocation-requests',
         name: 'ToolInvocationRequested',
      },
      PlanStepCompleted: {
         dir: 'conversation-events',
         name: 'PlanStepCompleted',
      },
      PlanCompleted: { dir: 'conversation-events', name: 'PlanCompleted' },
      PlanFailed: { dir: 'conversation-events', name: 'PlanFailed' },
      FinalAnswerSynthesized: {
         dir: 'conversation-events',
         name: 'FinalAnswerSynthesized',
      },
   };

function getSchemasDir(): string {
   const scriptDir =
      typeof (import.meta as { dir?: string }).dir === 'string'
         ? (import.meta as { dir: string }).dir
         : path.dirname(fileURLToPath(import.meta.url));
   const fromModule = path.join(scriptDir, '..', '..', 'schemas');
   if (
      existsSync(
         path.join(fromModule, 'user-commands', 'UserQueryReceived.schema.json')
      )
   ) {
      return fromModule;
   }
   const fromCwd = path.join(process.cwd(), 'schemas');
   if (
      existsSync(
         path.join(fromCwd, 'user-commands', 'UserQueryReceived.schema.json')
      )
   ) {
      return fromCwd;
   }
   const fromCwdServer = path.join(
      process.cwd(),
      'packages',
      'server',
      'schemas'
   );
   if (
      existsSync(
         path.join(
            fromCwdServer,
            'user-commands',
            'UserQueryReceived.schema.json'
         )
      )
   ) {
      return fromCwdServer;
   }
   return fromModule;
}

const ajv = new Ajv({ allErrors: true });
const validators = new Map<string, ValidateFunction>();

function loadSchema(dir: string, name: string): ValidateFunction {
   const schemasDir = getSchemasDir();
   const filePath = path.join(schemasDir, dir, `${name}.schema.json`);
   if (!existsSync(filePath)) {
      throw new Error(`Schema not found: ${filePath}`);
   }
   const raw = readFileSync(filePath, 'utf-8');
   const schema = JSON.parse(raw) as object;
   const validate = ajv.compile(schema);
   return validate;
}

function getValidator(eventType: string): ValidateFunction | null {
   const entry = EVENT_TYPE_TO_SCHEMA[eventType];
   if (!entry) return null;
   let validate = validators.get(entry.name);
   if (!validate) {
      try {
         validate = loadSchema(entry.dir, entry.name);
         validators.set(entry.name, validate);
      } catch (err) {
         console.error(
            `[Schema] Failed to load ${entry.name}:`,
            err instanceof Error ? err.message : err
         );
         return null;
      }
   }
   return validate;
}

export interface ValidationResult {
   valid: boolean;
   errors?: string[];
}

/**
 * Validate a payload against the JSON schema for its eventType.
 * eventType must be the string value of the "eventType" field in the payload.
 */
export function validateEvent(payload: unknown): ValidationResult {
   if (payload == null || typeof payload !== 'object') {
      return { valid: false, errors: ['Payload must be an object'] };
   }
   const eventType = (payload as Record<string, unknown>).eventType;
   if (typeof eventType !== 'string') {
      return { valid: false, errors: ['Missing or invalid eventType'] };
   }
   const validate = getValidator(eventType);
   if (!validate) {
      return { valid: false, errors: [`Unknown eventType: ${eventType}`] };
   }
   const ok = validate(payload);
   if (ok) return { valid: true };
   const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || '/'}: ${e.message ?? 'validation failed'}`
   );
   return { valid: false, errors };
}
