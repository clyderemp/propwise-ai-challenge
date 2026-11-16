import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

export const PASSWORD = 'challenge123';
export const SARA = 'sara@marinabay.test';
export const OMAR = 'omar@desertkey.test';

/** Boots the whole API on a random local port. `customise` may override providers before compiling. */
export async function bootApp(customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customise) builder = customise(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.listen(0, '127.0.0.1');
  return app;
}

export async function login(app: INestApplication<App>, email: string): Promise<string> {
  const response = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(200);
  return response.body.accessToken as string;
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
