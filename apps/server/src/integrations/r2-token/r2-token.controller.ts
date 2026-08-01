import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { R2TokenService } from './r2-token.service';

@Controller('r2')
export class R2TokenController {
  constructor(private readonly r2TokenService: R2TokenService) {}

  /**
   * Public on purpose: publicly shared pages render R2-hosted images too, and
   * the token only unlocks assets on a domain that is already reachable by
   * anyone holding a share link.
   */
  @Public()
  @Get('token')
  async getToken() {
    const { token, expiresAt } = await this.r2TokenService.getToken();
    return { token, expiresAt };
  }
}
