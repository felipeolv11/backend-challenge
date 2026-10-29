import { createApp } from './create-app';

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Wagering service listening on port ${port}`);
