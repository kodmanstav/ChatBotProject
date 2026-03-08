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

         // מחזירים טקסט (כמו אצלך)
         res.setHeader('Content-Type', 'text/plain; charset=utf-8');
         return res.send(result.message);
      } catch (err) {
         console.error('[routes] /api/chat error:', err);
         return res.status(500).json({ error: 'Internal Server Error' });
      }
   }
);

export default router;
