import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { EcourtsModule } from '../ecourts/ecourts.module';
import { ChatAdmissionMiddleware, ChatAdmissionModule } from './chat-admission.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LandingController } from './landing.controller';
import { WebUiController } from './web-ui.controller';

/**
 * The web surface: the public landing page, the signed-in application, and the
 * API behind it.
 *
 * The landing page lives here rather than in its own module because it is the
 * same surface with the same dependencies - it needs AuthModule to recognise a
 * returning advocate and AiModule to know whether this deployment can actually
 * do what the page describes. A separate module would be an import list copied
 * from this one.
 *
 * Web-process only. Unlike the WhatsApp side there is nothing here for the
 * worker to do - a browser request is answered on the connection it arrived on,
 * so there is no queue and no consumer. See the class comment in
 * chat.service.ts for why the two clients differ on that.
 */
@Module({
  imports: [AiModule, AuthModule, CreditsModule, EcourtsModule, ChatAdmissionModule],
  controllers: [LandingController, WebUiController, ChatController],
  providers: [ChatService],
})
export class WebModule implements NestModule {
  /** Each question takes an answer slot before the session lookup - see ChatAdmissionMiddleware. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ChatAdmissionMiddleware).forRoutes({ path: 'api/chat/ask', method: RequestMethod.POST });
  }
}
