export * from '../src/testing';
import { testDbs, closeTestDbs, testEnv as env } from '../src/testing';
export const dbs = testDbs();
export const closeAll = closeTestDbs;
export const testEnv = env();
