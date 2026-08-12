// Runs before every test file's imports (Vitest setupFiles), so lib/env's
// eager validation always has what it needs — no real .env file required
// to run the suite (e.g. in CI).
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/serviqo-test";
process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-access-token-secret-not-used-outside-tests";
process.env.LOG_LEVEL = "silent";
