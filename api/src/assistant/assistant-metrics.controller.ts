import { Controller, Get, Query } from '@nestjs/common';
import { AuthAgent, CurrentAgent } from '../auth/decorators';
import { AssistantMetricsQuery } from './assistant.dto';
import { AssistantService } from './assistant.service';

const DEFAULT_SINCE_HOURS = 168;

/** Extra endpoint: health of the caller's agency's assistant runs (auth required, agency-scoped). */
@Controller('assistant')
export class AssistantMetricsController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('metrics')
  metrics(@CurrentAgent() agent: AuthAgent, @Query() query: AssistantMetricsQuery) {
    return this.assistant.metrics(agent.agencyId, query.sinceHours ?? DEFAULT_SINCE_HOURS);
  }
}
