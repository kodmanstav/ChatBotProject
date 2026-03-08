import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import router from './routes';

dotenv.config();

const app = express();

app.use(
   cors({
      origin: ['http://localhost:5173', 'http://localhost:3000'],
      credentials: true,
   })
);

app.use(express.json());
app.use(router);

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
   console.log(`server is running on http://localhost:${port}`);
});
