import { Module, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClaudeAssistantAgent } from './agent/claude-assistant.agent';
import { PropertiesModule } from '../properties/properties.module';
import { TasksModule } from '../tasks/tasks.module';
import { AssistantMetricsController } from './assistant-metrics.controller';
import { AssistantController } from './assistant.controller';
import { FakeAssistantAgent } from './assistant.fake-agent';
import { AssistantService } from './assistant.service';
import { AgentPort, ASSISTANT_AGENT } from './assistant.types';
import { AssistantTelemetry } from './observability/assistant-telemetry';

/**
 * Which AgentPort to use, read at startup. Default: the Claude agent. ASSISTANT_AGENT_IMPL=fake selects the
 * scripted agent (e2e tests: no API key, no spend). Anything else is a configuration error.
 */
export function assistantAgentClass(impl = process.env.ASSISTANT_AGENT_IMPL): Type<AgentPort> {
  switch (impl ?? '') {
    case '':
    case 'claude':
      return ClaudeAssistantAgent;
    case 'fake':
      return FakeAssistantAgent;
    default:
      throw new Error(`Unknown ASSISTANT_AGENT_IMPL "${impl}". Use "claude" (default) or "fake".`);
  }
}

@Module({
  // The Claude agent reads listings and the lead's tasks through these services (read-only).
  imports: [PropertiesModule, TasksModule],
  controllers: [AssistantController, AssistantMetricsController],
  providers: [
    AssistantService,
    AssistantTelemetry,
    {
      provide: ASSISTANT_AGENT,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef): Promise<AgentPort> => moduleRef.create(assistantAgentClass()),
    },
  ],
  exports: [AssistantService],
})
export class AssistantModule {}
