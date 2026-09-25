const path = require('path');
const ts = require('typescript');
const { pathsToModuleNameMapper } = require('ts-jest');

// Jest does not read tsconfig `paths`, so derive its moduleNameMapper from the
// same entry the compiler uses rather than restating it here. The root
// tsconfig.json contains comments, so it is read with TypeScript's own reader.
const tsconfigPath = path.join(__dirname, 'tsconfig.json');
const { config: rootTsconfig } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
const aliasMapper = pathsToModuleNameMapper(
  (rootTsconfig.compilerOptions && rootTsconfig.compilerOptions.paths) || {},
  { prefix: '<rootDir>/' }
);

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-preset-angular',
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'],
  testEnvironment: 'jsdom',
  // `backend/` is a SEPARATE project with its own jest config, tsconfig and
  // node environment (better-sqlite3, Express, supertest). Without this, the
  // Angular run picks up backend/test/*.test.ts and fails them under jsdom.
  // Run backend tests with `npm test` inside backend/.
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
    '<rootDir>/e2e/',
    '<rootDir>/backend/'
  ],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    ...aliasMapper,
  },
};
