// Keep application tests independent of the developer's .env and shell settings.
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.SWAGGER_ENABLED = 'true';
