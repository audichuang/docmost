import { Module } from '@nestjs/common';
import { R2TokenService } from './r2-token.service';
import { ContentTransformerService } from './content-transformer.service';
import { R2TokenController } from './r2-token.controller';
import { EnvironmentModule } from '../environment/environment.module';

@Module({
  imports: [EnvironmentModule],
  controllers: [R2TokenController],
  providers: [R2TokenService, ContentTransformerService],
  exports: [R2TokenService, ContentTransformerService],
})
export class R2TokenModule {}
