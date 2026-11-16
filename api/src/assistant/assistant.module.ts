import { Module, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PropertiesModule } from '../properties/properties.module';
import { TasksModule } from '../tasks/tasks.module';
import { AssistantController } from './assistant.controller';
import { FakeAssistantAgent } from './assistant.fake-agent';
import { AssistantService } from './assistant.service';
import { AgentPort, ASSISTANT_AGENT } from './assistant.types';

/**
 * Which AgentPort to use, read at startup: ASSISTANT_AGENT_IMPL=fake selects the scripted agent (e2e tests,
 * no API key, no spend). The default will be the Claude agent once api/src/assistant/agent exports it.
 */
export function assistantAgentClass(impl = process.env.ASSISTANT_AGENT_IMPL): Type<AgentPort> {
  switch (impl) {
    case 'fake':
    default:
      return FakeAssistantAgent;
  }
}

@Module({
  // The Claude agent reads listings and the lead's tasks through these services (read-only).
  imports: [PropertiesModule, TasksModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    {
      provide: ASSISTANT_AGENT,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef): Promise<AgentPort> => moduleRef.create(assistantAgentClass()),
    },
  ],
  exports: [AssistantService],
})
export class AssistantModule {}
