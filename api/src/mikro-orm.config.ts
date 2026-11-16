import 'reflect-metadata';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { join } from 'node:path';
import { config } from './config';
import { Agency, Agent, AssistantRun, Lead, Message, Property, ProposedAction, Task } from './entities';

export function buildOrmConfig() {
  return defineConfig({
    clientUrl: config.databaseUrl(),
    entities: [Agency, Agent, Lead, Message, Property, Task, AssistantRun, ProposedAction],
    extensions: [Migrator],
    migrations: {
      path: join(__dirname, 'migrations'),
      pathTs: join(__dirname, 'migrations'),
      // Skips macOS AppleDouble files (._*) that external volumes create next to every file.
      glob: '!(*.d|._*).{js,ts}',
      transactional: true,
      snapshot: false,
    },
    debug: false,
  });
}

export default buildOrmConfig;
