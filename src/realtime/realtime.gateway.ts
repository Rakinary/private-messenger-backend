import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { BadRequestException, Injectable, Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { ChatsService } from '../chats/chats.service';
import { CreateMessageDto } from '../messages/dto/create-message.dto';
import { MessagesService } from '../messages/messages.service';

interface AuthedSocket extends Socket {
  data: {
    user?: {
      sub: string;
      email: string;
      username: string;
    };
  };
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly authService: AuthService,
    private readonly chatsService: ChatsService,
    private readonly messagesService: MessagesService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        this.extractBearer(client.handshake.headers.authorization);

      if (!token) {
        client.emit('error', { message: 'Missing token' });
        client.disconnect();
        return;
      }

      const user = await this.authService.verifyToken(token);
      client.data.user = user;
      await client.join(`user:${user.sub}`);
      client.emit('ready', { user });
      this.logger.log(`Socket connected: ${user.username}`);
    } catch (error) {
      client.emit('error', { message: 'Unauthorized socket connection' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthedSocket) {
    const user = client.data.user;
    if (user) {
      this.logger.log(`Socket disconnected: ${user.username}`);
    }
  }

  @SubscribeMessage('join_chat')
  async joinChat(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatId: string },
  ) {
    const user = this.requireUser(client);
    if (!body?.chatId) {
      throw new BadRequestException('chatId is required');
    }

    await this.chatsService.ensureUserIsChatMember(body.chatId, user.sub);
    await client.join(`chat:${body.chatId}`);
    return { ok: true };
  }

  @SubscribeMessage('leave_chat')
  async leaveChat(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatId: string },
  ) {
    if (!body?.chatId) {
      throw new BadRequestException('chatId is required');
    }

    await client.leave(`chat:${body.chatId}`);
    return { ok: true };
  }

  @SubscribeMessage('typing')
  async typing(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatId: string; isTyping: boolean },
  ) {
    const user = this.requireUser(client);

    if (!body?.chatId) {
      throw new BadRequestException('chatId is required');
    }

    await this.chatsService.ensureUserIsChatMember(body.chatId, user.sub);

    client.to(`chat:${body.chatId}`).emit('chat:typing', {
      chatId: body.chatId,
      userId: user.sub,
      username: user.username,
      isTyping: !!body.isTyping,
    });

    return { ok: true };
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('send_message')
  async sendMessage(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: CreateMessageDto,
  ) {
    const user = this.requireUser(client);
    const message = await this.messagesService.create(user.sub, body);
    await this.broadcastNewMessage(message.chatId, message);
    return message;
  }

  async broadcastNewMessage(chatId: string, message: unknown) {
    const memberIds = await this.chatsService.getChatMemberIds(chatId);

    for (const userId of memberIds) {
      this.server.to(`user:${userId}`).emit('message:new', message);
    }

    this.server.to(`chat:${chatId}`).emit('message:new', message);
  }

  private extractBearer(header?: string) {
    if (!header) return undefined;
    const [type, token] = header.split(' ');
    if (type?.toLowerCase() !== 'bearer') return undefined;
    return token;
  }

  private requireUser(client: AuthedSocket) {
    const user = client.data.user;
    if (!user) {
      throw new BadRequestException('Socket user is missing');
    }
    return user;
  }
}
