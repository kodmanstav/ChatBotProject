import type { Kafka } from 'kafkajs';
import { validateEvent } from '../schemas/validator';
import { TOPICS } from './client';
import { logError } from '../utils/logger';

export interface PublishOptions {
   topic: string;
   value: object;
   sendToDlqOnValidationFailure?: boolean;
}

/**
 * Validates the payload against the schema for its eventType.
 * If valid, sends to the given topic. If invalid and sendToDlqOnValidationFailure,
 * sends raw payload to dead-letter-queue. Otherwise does not publish.
 */
export async function publishValidated(
   producer: Awaited<ReturnType<Kafka['producer']>>,
   options: PublishOptions
): Promise<boolean> {
   const { topic, value, sendToDlqOnValidationFailure = true } = options;
   const result = validateEvent(value);
   if (!result.valid) {
      logError('Validation failed:', result.errors?.join('; '));
      if (sendToDlqOnValidationFailure) {
         try {
            await producer.send({
               topic: TOPICS.DEAD_LETTER_QUEUE,
               messages: [
                  {
                     value: JSON.stringify({
                        raw: value,
                        errors: result.errors,
                     }),
                  },
               ],
            });
            logError('Invalid event sent to dead-letter-queue.');
         } catch (e) {
            logError('Failed to send to DLQ:', e);
         }
      }
      return false;
   }
   await producer.send({
      topic,
      messages: [{ value: JSON.stringify(value) }],
   });
   return true;
}
