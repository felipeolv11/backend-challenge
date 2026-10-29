import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const app = await NestFactory.create(AppModule);
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Wagering service listening on port ${port}`);
