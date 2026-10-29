import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
})
export class AppModule {}
