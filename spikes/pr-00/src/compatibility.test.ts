import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  Body,
  Controller,
  Cookies,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  Module,
  Post,
  Res,
  StandardSchemaValidationPipe,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AuthenticationModule,
  AuthenticationRegistry,
  AuthenticationStorage,
  JwtBearerProvider,
  PasswordHasher,
  Public,
  TokenService,
  type JwtClaims,
  type AuthenticationModuleOptions,
} from "@nestjs/authentication";
import { authenticationStoreContract } from "@nestjs/authentication/testing";
import { AuthorizationModule, Can, Policy } from "@nestjs/authorization";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DrizzleModule, InjectDrizzle } from "@nestjs/drizzle";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { CookieOptions, Response } from "express";
import { Pool } from "pg";
import { z } from "zod";

// Disposable compatibility fixtures, not application routes or production storage.
const input = z.strictObject({ name: z.string().min(1) });
const cookieName = "__Host-refresh";
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};
const origin = "https://frontend.example.test";
const authOptions: AuthenticationModuleOptions = {
  accessToken: { key: randomBytes(32), ttl: "15m" },
  refreshToken: { ttl: "7d", absoluteTtl: "7d" },
};
type User = { id: string; role: "user" | "admin" };

@Injectable()
class BearerAuth extends JwtBearerProvider<User> {
  constructor(registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this);
  }
  protected validate(claims: JwtClaims): User | null {
    return claims.sub === "user" || claims.sub === "admin"
      ? { id: claims.sub, role: claims.sub }
      : null;
  }
}

@Policy()
class SpikePolicy {
  admin(user: User | null) {
    return user?.role === "admin";
  }
}

@Controller()
class SpikeController {
  constructor(private readonly tokens: TokenService) {}

  @Public()
  @Post("validate")
  validate(@Body({ schema: input }) body: z.infer<typeof input>) {
    return body;
  }

  @Get("admin")
  @Can(SpikePolicy, "admin")
  admin() {
    return { ok: true };
  }

  @Get("undeclared")
  undeclared() {
    return { mustNotRun: true };
  }

  @Public()
  @Post("refresh")
  async refresh(
    @Cookies(cookieName) token: string | undefined,
    @Headers("origin") requestOrigin: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (requestOrigin !== origin) throw new ForbiddenException();
    if (!token) throw new UnauthorizedException();
    const { accessToken, expiresIn, refreshToken } =
      await this.tokens.refresh(token);
    response.cookie(cookieName, refreshToken, cookieOptions);
    response.setHeader("Cache-Control", "no-store");
    return { accessToken, expiresIn };
  }

  @Public()
  @Post("logout")
  async logout(
    @Cookies(cookieName) token: string | undefined,
    @Headers("origin") requestOrigin: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (requestOrigin !== origin) throw new ForbiddenException();
    if (token) await this.tokens.revoke(token);
    response.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  }
}

@Module({
  imports: [
    AuthenticationModule.forRoot(authOptions),
    AuthorizationModule.forRoot(),
  ],
  controllers: [SpikeController],
  providers: [BearerAuth, SpikePolicy],
})
class SpikeModule {}

test("HTTP: validation, Swagger, guard order, CSRF and browser token transport", async () => {
  process.env.NODE_ENV = "test";
  const app = await NestFactory.create(SpikeModule, {
    logger: false,
    abortOnError: false,
  });
  app.enableCsrfProtection({ trustedOrigins: [origin] });
  app.useSecurityHeaders();
  app.enableCors({ origin: [origin], credentials: true });
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const request = (path: string, init?: RequestInit) =>
      fetch(base + path, init);
    const post = (body: unknown) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(
      (await request("/validate", post({ name: "probe" }))).status,
      201,
    );
    assert.equal((await request("/validate", post({ name: "" }))).status, 400);
    assert.equal(
      (await request("/validate", post({ name: "probe", role: "admin" })))
        .status,
      400,
    );
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("PR-00").setVersion("0").build(),
    );
    const body = document.paths["/validate"]?.post?.requestBody;
    assert.ok(body && "content" in body);
    const schema = body.content["application/json"].schema;
    assert.ok(schema && "properties" in schema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["name"]);
    assert.equal(
      schema.properties?.name &&
        "minLength" in schema.properties.name &&
        schema.properties.name.minLength,
      1,
    );

    const tokens = app.get(TokenService);
    const user = await tokens.issue("user");
    const admin = await tokens.issue("admin");
    assert.equal((await request("/admin")).status, 401);
    assert.equal(
      (
        await request("/admin", {
          headers: { Authorization: `Bearer ${user.accessToken}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/admin", {
          headers: { Authorization: `Bearer ${admin.accessToken}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/undeclared", {
          headers: { Authorization: `Bearer ${admin.accessToken}` },
        })
      ).status,
      403,
    );
    const cookie = `${cookieName}=${user.refreshToken}`;
    assert.equal(
      (
        await request("/refresh", {
          method: "POST",
          headers: { Cookie: cookie },
        })
      ).status,
      403,
    );
    const rejected = await request("/refresh", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.example.test",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("x-content-type-options"), "nosniff");
    const refreshed = await request("/refresh", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    assert.equal(refreshed.status, 201);
    assert.equal(refreshed.headers.get("access-control-allow-origin"), origin);
    assert.equal(
      refreshed.headers.get("access-control-allow-credentials"),
      "true",
    );
    assert.equal(refreshed.headers.get("cache-control"), "no-store");
    const payload = (await refreshed.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["accessToken", "expiresIn"]);
    assert.equal(payload.expiresIn, 900);
    const setCookie = refreshed.headers.get("set-cookie");
    assert.ok(setCookie);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      assert.ok(setCookie.includes(flag));
    assert.ok(!setCookie.includes("Domain="));
    const logout = await request("/logout", {
      method: "POST",
      headers: { Cookie: setCookie.split(";")[0], Origin: origin },
    });
    assert.equal(logout.status, 201);
    assert.ok(
      logout.headers.get("set-cookie")?.includes("Expires=Thu, 01 Jan 1970"),
    );
    assert.equal(
      (
        await request("/refresh", {
          method: "POST",
          headers: { Cookie: setCookie.split(";")[0], Origin: origin },
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test("tokens: application session claim survives rotation; replay and racing refresh revoke successors", async () => {
  process.env.NODE_ENV = "test";
  const context = await NestFactory.createApplicationContext(SpikeModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const tokens = context.get(TokenService);
    const sid = randomUUID();
    const pair = await tokens.issue("user", { claims: { sid } });
    const rotated = await tokens.refresh(pair.refreshToken);
    const claims = JSON.parse(
      Buffer.from(rotated.accessToken.split(".")[1], "base64url").toString(),
    ) as JwtClaims;
    assert.equal(claims.sid, sid);
    await assert.rejects(tokens.refresh(pair.refreshToken));
    await assert.rejects(tokens.refresh(rotated.refreshToken));
    const fresh = await tokens.issue("user");
    const racing = await Promise.allSettled([
      tokens.refresh(fresh.refreshToken),
      tokens.refresh(fresh.refreshToken),
    ]);
    assert.equal(
      racing.filter((result) => result.status === "fulfilled").length,
      1,
    );
    for (const result of racing)
      if (result.status === "fulfilled")
        await assert.rejects(tokens.refresh(result.value.refreshToken));
    const another = await tokens.issue("user");
    await tokens.revokeAll("user");
    await assert.rejects(tokens.refresh(another.refreshToken));
    // Proves the public contract harness can be imported and selects the right cases.
    const cases = authenticationStoreContract(
      () => ({
        refreshTokens: context.get(AuthenticationStorage).refreshTokens,
      }),
      { contracts: ["refreshTokens"], concurrent: true },
    );
    assert.ok(cases.length > 0);
    assert.ok(cases.every((item) => item.contract === "refreshTokens"));
  } finally {
    await context.close();
  }
});

test("production startup refuses a missing refresh store", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(async () => {
      const app = await NestFactory.createApplicationContext(SpikeModule, {
        logger: false,
        abortOnError: false,
      });
      await app.close();
    }, /RefreshTokenStore/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("Zod configuration validates and transforms; missing required configuration fails", async () => {
  const schema = z.object({ PR00_PORT: z.coerce.number().default(4321) });
  @Module({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        validatePredefined: false,
        validationSchema: schema,
      }),
    ],
  })
  class ConfigurationProbe {}
  const app = await NestFactory.createApplicationContext(ConfigurationProbe, {
    logger: false,
    abortOnError: false,
  });
  try {
    assert.equal(app.get(ConfigService).get("PR00_PORT"), 4321);
  } finally {
    await app.close();
  }
  await assert.rejects(
    ConfigModule.forRoot({
      ignoreEnvFile: true,
      validatePredefined: false,
      validationSchema: z.object({ PR00_REQUIRED: z.string() }),
    }),
  );
});

test("Drizzle module injects the pg driver, compiles SQL and closes the pool (no DB connection)", async () => {
  const pool = new Pool({
    connectionString: "postgresql://localhost:1/pr00_not_connected",
  });
  let closed = false;
  const end = pool.end.bind(pool);
  pool.end = async () => {
    closed = true;
    await end();
  };
  const db = drizzle(pool);
  const example = pgTable("pr00_example", { id: text().primaryKey() });
  @Injectable()
  class QueryProbe {
    constructor(@InjectDrizzle() readonly database: NodePgDatabase) {}
  }
  @Module({ imports: [DrizzleModule.forRoot({ db })], providers: [QueryProbe] })
  class DatabaseProbe {}
  const app = await NestFactory.createApplicationContext(DatabaseProbe, {
    logger: false,
    abortOnError: false,
  });
  try {
    assert.match(
      app.get(QueryProbe).database.select().from(example).toSQL().sql,
      /pr00_example/,
    );
  } finally {
    await app.close();
  }
  assert.ok(closed);
});

test("package scrypt hasher verifies passwords (reduced cost only for the spike)", async () => {
  const hasher = new PasswordHasher({ logN: 10 });
  const password = randomBytes(32).toString("base64url");
  const hash = await hasher.hash(password);
  assert.ok(await hasher.verify(password, hash));
  assert.equal(await hasher.verify("incorrect", hash), false);
});
