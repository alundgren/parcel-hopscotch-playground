import { Effect, Schema } from "effect";

const ServerConfigSchema = Schema.Struct({
  environment: Schema.Literals(["development", "test", "production"]),
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  publicOrigin: Schema.String,
  databasePath: Schema.String,
  allowDevelopmentIdentity: Schema.Boolean,
  developmentEmail: Schema.NullOr(Schema.String),
});

export type ServerConfig = typeof ServerConfigSchema.Type;

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerConfig, ConfigError> => {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  const candidate = {
    environment: nodeEnvironment,
    host: environment.HOST ?? "127.0.0.1",
    port: Number(environment.PORT ?? "3000"),
    publicOrigin: environment.PUBLIC_ORIGIN ?? "http://127.0.0.1:5173",
    databasePath: environment.DATABASE_PATH ?? ".tmp/parcel-hopscotch.sqlite",
    allowDevelopmentIdentity: environment.ENABLE_DEV_IDENTITY === "true",
    developmentEmail: environment.DEV_USER_EMAIL ?? null,
  };

  return Schema.decodeUnknownEffect(ServerConfigSchema)(candidate).pipe(
    Effect.mapError(
      (error) => new ConfigError({ message: `Invalid server configuration: ${error}` }),
    ),
    Effect.flatMap((config) => {
      if (config.environment === "production" && config.allowDevelopmentIdentity) {
        return Effect.fail(
          new ConfigError({
            message: "Development identity cannot be enabled in production.",
          }),
        );
      }
      return Effect.succeed(config);
    }),
  );
};
