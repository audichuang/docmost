import { Module } from '@nestjs/common';
import { R2TokenController } from './r2-token.controller';
import { R2TokenService } from './r2-token.service';

@Module({
  controllers: [R2TokenController],
  providers: [R2TokenService],
  exports: [R2TokenService],
})
export class R2TokenModule {}
