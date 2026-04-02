import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('query') query?: string,
  ) {
    return this.usersService.list(user.sub, query);
  }

  @Post('push-token')
  savePushToken(
    @CurrentUser() user: JwtUser,
    @Body('expoPushToken') expoPushToken?: string,
  ) {
    return this.usersService.savePushToken(user.sub, expoPushToken);
  }
}

