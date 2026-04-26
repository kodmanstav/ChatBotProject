import { z } from 'zod';
import { Router, type Request, type Response } from 'express';
import { chatService } from './services/chat.service';

const router = Router();

const chatSchema = z.object({
   prompt: z.string().min(1),
   conversationId: z.string().uuid(),
});

type ChatBody = z.infer<typeof chatSchema>;

router.get('/health', (_req: Request, res: Response) => {
   return res.json({ ok: true });
});

router.post(
   '/api/chat',
   async (req: Request<{}, {}, ChatBody>, res: Response) => {
      const parsed = chatSchema.safeParse(req.body);

      if (!parsed.success) {
         return res.status(400).json({
            error: 'Bad Request',
            details: parsed.error.flatten(),
         });
      }

      const { prompt, conversationId } = parsed.data;

      try {
         const result = await chatService.sendMessage(prompt, conversationId);
         return res.json(result);
      } catch (err) {
         console.error('[routes] /api/chat error:', err);
         if (err instanceof Error && err.message.includes('Timed out')) {
            return res.status(504).json({ error: 'Gateway Timeout' });
         }
         return res.status(500).json({ error: 'Internal Server Error' });
      }
   }
);

export default router;
