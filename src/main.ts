import { Logger } from '@nestjs/common';
import { createApp } from './create-app';

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
new Logger('Bootstrap').log({ event: 'http_listening', port });
