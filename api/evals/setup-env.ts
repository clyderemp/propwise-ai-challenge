import 'dotenv/config';

// The evals run the real Claude agent against the database `pnpm db:reset` seeded (DATABASE_URL),
// not the e2e test database. Fail early and clearly when something would make them meaningless.
if (process.env.ASSISTANT_AGENT_IMPL && process.env.ASSISTANT_AGENT_IMPL !== 'claude') {
  throw new Error(`Evals need the real agent; ASSISTANT_AGENT_IMPL is "${process.env.ASSISTANT_AGENT_IMPL}".`);
}
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  throw new Error('ANTHROPIC_API_KEY is not set (api/.env). The evals call the real model.');
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy api/.env.example to api/.env and run pnpm db:reset.');
}
