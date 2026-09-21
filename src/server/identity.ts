import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { ServerConfig } from "./config.js";

const headerName = "cf-access-authenticated-user-email";
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

export class IdentityError extends Schema.TaggedError<IdentityError>()("IdentityError", {
  code: Schema.Literals([
    "missing_identity",
    "duplicate_identity",
    "malformed_identity",
    "development_identity_disabled",
  ]),
  message: Schema.String,
}) {}

export interface RequestIdentity {
  readonly id: string;
  readonly digest: string;
}

const validateEmail = (value: string): Effect.Effect<string, IdentityError> => {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    normalized.length === 0 ||
    normalized.includes(",") ||
    !emailPattern.test(normalized)
  ) {
    return Effect.fail(
      new IdentityError({
        code: "malformed_identity",
        message: "The authenticated identity header is malformed.",
      }),
    );
  }
  return Effect.succeed(normalized);
};

const internalIdentity = (email: string): RequestIdentity => {
  const digest = createHash("sha256")
    .update(`parcel-hopscotch:${email}`, "utf8")
    .digest("hex");
  return {
    digest,
    id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
  };
};

export const resolveIdentity = (
  rawHeaders: ReadonlyArray<string>,
  config: ServerConfig,
): Effect.Effect<RequestIdentity, IdentityError> =>
  Effect.gen(function* () {
    const values: Array<string> = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === headerName) {
        values.push(rawHeaders[index + 1] ?? "");
      }
    }

    if (values.length > 1) {
      return yield* new IdentityError({
        code: "duplicate_identity",
        message: "Exactly one authenticated identity header is required.",
      });
    }

    if (values.length === 1) {
      return internalIdentity(yield* validateEmail(values[0]!));
    }

    if (config.environment === "production") {
      return yield* new IdentityError({
        code: "missing_identity",
        message: "An authenticated identity header is required.",
      });
    }

    if (!config.allowDevelopmentIdentity || config.developmentEmail === null) {
      return yield* new IdentityError({
        code: "development_identity_disabled",
        message: "Development identity is disabled.",
      });
    }

    return internalIdentity(yield* validateEmail(config.developmentEmail));
  });
