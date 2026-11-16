import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthAgent, CurrentAgent } from '../auth/decorators';
import { CreateAssistantRunDto, ListAssistantRunsQuery } from './assistant.dto';
import { AssistantService } from './assistant.service';

@Controller('leads/:leadId/assistant/runs')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /** 201 with the run, also when it failed (status "failed"). */
  @Post()
  createRun(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: CreateAssistantRunDto,
  ) {
    return this.assistant.createRun(agent, leadId, dto ?? {});
  }

  /** Extra endpoint: the lead's runs, newest first (the panels load the latest with ?limit=1). */
  @Get()
  listRuns(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Query() query: ListAssistantRunsQuery,
  ) {
    return this.assistant.listRuns(agent.agencyId, leadId, query.limit ?? 20);
  }

  @Get(':runId')
  getRun(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.assistant.getRun(agent.agencyId, leadId, runId);
  }

  @Post(':runId/actions/:actionId/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.assistant.approve(agent, leadId, runId, actionId);
  }

  @Post(':runId/actions/:actionId/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.assistant.reject(agent, leadId, runId, actionId);
  }
}
