import { Migration } from '@mikro-orm/migrations';

export class Migration20261116100246 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "assistant_runs" ("id" uuid not null, "agency_id" uuid not null, "lead_id" uuid not null, "message_id" uuid not null, "requested_by_id" uuid not null, "status" text check ("status" in ('running', 'completed', 'failed')) not null default 'running', "error" text null, "requirements" jsonb not null, "recommendations" jsonb not null, "summary" text not null default '', "trace" jsonb not null, "diagnostics" jsonb null, "data_warnings" jsonb null, "model" varchar(255) null, "created_at" timestamptz not null, "finished_at" timestamptz null, constraint "assistant_runs_pkey" primary key ("id"));`);
    this.addSql(`create index "assistant_runs_lead_id_created_at_index" on "assistant_runs" ("lead_id", "created_at");`);

    this.addSql(`create table "proposed_actions" ("id" uuid not null, "agency_id" uuid not null, "run_id" uuid not null, "lead_id" uuid not null, "type" text check ("type" in ('create_follow_up_task')) not null, "status" text check ("status" in ('pending_approval', 'approved', 'rejected')) not null default 'pending_approval', "task" jsonb not null, "needs_clarification" text null, "created_task_id" uuid null, "decided_by_id" uuid null, "decided_at" timestamptz null, "created_at" timestamptz not null, constraint "proposed_actions_pkey" primary key ("id"));`);
    this.addSql(`alter table "proposed_actions" add constraint "proposed_actions_created_task_id_unique" unique ("created_task_id");`);
    this.addSql(`create index "proposed_actions_run_id_created_at_index" on "proposed_actions" ("run_id", "created_at");`);

    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_agency_id_foreign" foreign key ("agency_id") references "agencies" ("id") on update cascade;`);
    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_lead_id_foreign" foreign key ("lead_id") references "leads" ("id") on update cascade;`);
    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_message_id_foreign" foreign key ("message_id") references "messages" ("id") on update cascade;`);
    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_requested_by_id_foreign" foreign key ("requested_by_id") references "agents" ("id") on update cascade;`);

    this.addSql(`alter table "proposed_actions" add constraint "proposed_actions_agency_id_foreign" foreign key ("agency_id") references "agencies" ("id") on update cascade;`);
    this.addSql(`alter table "proposed_actions" add constraint "proposed_actions_run_id_foreign" foreign key ("run_id") references "assistant_runs" ("id") on update cascade;`);
    this.addSql(`alter table "proposed_actions" add constraint "proposed_actions_lead_id_foreign" foreign key ("lead_id") references "leads" ("id") on update cascade;`);
    this.addSql(`alter table "proposed_actions" add constraint "proposed_actions_created_task_id_foreign" foreign key ("created_task_id") references "tasks" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "proposed_actions" add constraint "proposed_actions_decided_by_id_foreign" foreign key ("decided_by_id") references "agents" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "proposed_actions" drop constraint "proposed_actions_run_id_foreign";`);

    this.addSql(`drop table if exists "assistant_runs" cascade;`);

    this.addSql(`drop table if exists "proposed_actions" cascade;`);
  }

}
